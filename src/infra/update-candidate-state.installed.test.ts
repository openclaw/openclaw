import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { readUpdateStateSchemaVersions } from "./update-candidate-state.js";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-installed-")));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeCandidateWorkers(packageRoot: string, legacy: boolean): Promise<void> {
  const directory = path.join(packageRoot, "dist/infra");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), '{"type":"module"}');
  // These fixtures implement the released command shapes, not updater-relative imports.
  await fs.writeFile(
    path.join(directory, "update-candidate-state.worker.js"),
    `
    import fs from "node:fs";
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const parsed = JSON.parse(input);
    if (parsed.mode !== "versions" && (${legacy} || parsed.mode !== "discover")) {
      throw new Error("Unknown update state inspection mode");
    }
    const report = process.env.CANDIDATE_SNAPSHOT_REPORT;
    if (${legacy} && report && fs.existsSync(report)) {
      if (fs.existsSync(JSON.parse(fs.readFileSync(report, "utf8")).location)) {
        throw new Error("Discovery snapshot overlaps legacy versions inspection");
      }
    }
    const file = path.join(parsed.stateDir, "state", "openclaw.sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    let files;
    let sharedVersion;
    try {
      files = [file, ...db.prepare("SELECT path FROM agent_databases ORDER BY path").all().map(row => row.path)];
      sharedVersion = { path: file, userVersion: db.prepare("PRAGMA user_version").get().user_version };
    } finally { db.close(); }
    const versions = files.map(file => {
      const db = new DatabaseSync(file, { readOnly: true });
      try { return { path: file, userVersion: db.prepare("PRAGMA user_version").get().user_version }; }
      finally { db.close(); }
    });
    console.log(JSON.stringify(parsed.mode === "discover"
      ? { files: files.map(file => [file, { spellings: [file] }]), sharedVersion }
      : versions));
  `,
  );
  await fs.writeFile(
    path.join(directory, "sqlite-readonly-location.worker.js"),
    `
    import fs from "node:fs";
    import path from "node:path";
    if (process.argv[2] !== "--openclaw-sqlite-readonly-child" || process.argv[3] !== "sync") {
      throw new Error("Unexpected SQLite snapshot worker protocol");
    }
    const directory = fs.mkdtempSync(path.join(process.argv[5], "legacy-copy-"));
    const location = path.join(directory, "database.sqlite");
    fs.copyFileSync(process.argv[4], location);
    fs.writeFileSync(process.env.CANDIDATE_SNAPSHOT_REPORT, JSON.stringify({ location, pid: process.pid }));
    console.log(JSON.stringify({ ok: true, location }));
  `,
  );
}

it.each(
  (["modern", "legacy"] as const).flatMap((protocol) =>
    (["removed", "replaced"] as const).map((activation) => ({ protocol, activation })),
  ),
)(
  "inspects with the installed $protocol candidate after the old package is $activation",
  async ({ protocol, activation }) => {
    const stateDir = path.join(root, "state-owner");
    const shared = path.join(stateDir, "state", "openclaw.sqlite");
    const external = path.join(root, "registered.sqlite");
    await fs.mkdir(path.dirname(shared), { recursive: true });
    const agent = openNodeSqliteDatabase(external);
    agent.exec("PRAGMA user_version = 7;");
    agent.close();
    const db = openNodeSqliteDatabase(shared);
    db.exec("PRAGMA user_version = 3; CREATE TABLE agent_databases (path TEXT);");
    db.prepare("INSERT INTO agent_databases VALUES (?)").run(external);
    db.close();
    const sourceBytes = await fs.readFile(shared);
    const previousRoot = path.join(root, "previous-package");
    const candidateRoot =
      activation === "replaced" ? previousRoot : path.join(root, "candidate-package");
    await writeCandidateWorkers(previousRoot, false);
    const entrypoints = [
      runtimeProcessEntrypoints.updateCandidateState,
      runtimeProcessEntrypoints.sqliteReadOnly,
    ];
    const originalUrls = entrypoints.map((entry) => entry.currentModuleUrl);
    for (const entry of entrypoints) {
      Object.assign(entry, {
        currentModuleUrl: pathToFileURL(path.join(previousRoot, "dist/old-updater.js")).href,
      });
    }
    try {
      const before = await readUpdateStateSchemaVersions({ stateDir, config: {} });
      expect(before).toEqual([
        { path: shared, userVersion: 3 },
        { path: external, userVersion: 7 },
      ]);
      if (activation === "removed") {
        await fs.rm(previousRoot, { recursive: true });
      }
      await writeCandidateWorkers(candidateRoot, protocol === "legacy");
      const selectedNodeMarker = path.join(root, "selected-node-ran");
      let nodeRunner = process.execPath;
      if (process.platform !== "win32") {
        nodeRunner = path.join(root, "selected-node");
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        await fs.writeFile(
          nodeRunner,
          `#!/bin/sh\nprintf selected > ${quote(selectedNodeMarker)}\nexec ${quote(process.execPath)} "$@"\n`,
          { mode: 0o755 },
        );
      }
      const report = path.join(root, "snapshot.json");
      const after = await readUpdateStateSchemaVersions({
        stateDir,
        config: {},
        root: candidateRoot,
        nodeRunner,
        env: { ...process.env, CANDIDATE_SNAPSHOT_REPORT: report },
      });
      expect(after).toEqual(before);
      expect(await fs.readFile(shared)).toEqual(sourceBytes);
      if (protocol === "legacy") {
        const snapshot = JSON.parse(await fs.readFile(report, "utf8")) as {
          location: string;
          pid: number;
        };
        await expect(fs.stat(path.dirname(snapshot.location))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(() => process.kill(snapshot.pid, 0)).toThrow();
      }
      if (process.platform !== "win32") {
        expect(await fs.readFile(selectedNodeMarker, "utf8")).toBe("selected");
      }
    } finally {
      entrypoints.forEach((entry, index) =>
        Object.assign(entry, { currentModuleUrl: originalUrls[index] }),
      );
    }
  },
);
