import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runDoctorRepairSequence } from "./repair-sequencing.js";

export function registerSharedRuntimeReaderDoctorTests(): void {
  describe("shared plugin runtime", () => {
    const tempDirs = useAutoCleanupTempDirTracker(afterEach);

    it.each([
      { selector: "STATE_DIRECTORY", sameInstall: false },
      { selector: "STATE_DIRECTORY", sameInstall: true },
      { selector: "OPENCLAW_PLUGIN_STAGE_DIR", sameInstall: false },
      { selector: "OPENCLAW_PLUGIN_STAGE_DIR", sameInstall: true },
    ])(
      "preserves a live shared runtime reader through Doctor ($selector, same install: $sameInstall)",
      async ({ selector, sameInstall }) => {
        const tempDir = tempDirs.make("openclaw-doctor-shared-runtime-");
        const stateA = path.join(tempDir, ".openclaw");
        const stateB = path.join(tempDir, ".openclaw-peer");
        const packageRoot = path.join(tempDir, "prefix-a", "node_modules", "openclaw");
        const readerPackageRoot = sameInstall
          ? packageRoot
          : path.join(tempDir, "prefix-b", "node_modules", "openclaw");
        const sharedBase = path.join(
          tempDir,
          selector === "STATE_DIRECTORY"
            ? "shared/plugin-runtime-deps"
            : ".openclaw-install-stage-shared",
        );
        // Stable v2026.4.29 buckets are keyed by version and install path, not by
        // profile/database. Doctor cannot authorize deletion for another consumer.
        const packageHash = createHash("sha256")
          .update(readerPackageRoot)
          .digest("hex")
          .slice(0, 12);
        const bucket = path.join(sharedBase, `openclaw-2026.4.29-${packageHash}`);
        const dependency = path.join(bucket, "node_modules", "fixture-runtime-dependency");
        const mirror = path.join(bucket, "dist", "extensions", "fixture-reader");
        const alias = path.join(path.dirname(readerPackageRoot), "fixture-runtime-dependency");
        const unknownFile = path.join(sharedBase, "unknown-consumer", "keep.txt");
        const databasePath = (stateDir: string) => path.join(stateDir, "state", "openclaw.sqlite");
        const runtimeEnv = (stateDir: string) => ({
          HOME: tempDir,
          USERPROFILE: tempDir,
          OPENCLAW_HOME: tempDir,
          OPENCLAW_STATE_DIR: stateDir,
          [selector]: selector === "STATE_DIRECTORY" ? path.dirname(sharedBase) : sharedBase,
        });
        const writeFixture = async (directory: string, name: string, content: string) => {
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(path.join(directory, name), content);
        };
        for (const stateDir of [stateA, stateB]) {
          await fs.mkdir(path.join(stateDir, "state"), { recursive: true });
          const database = new DatabaseSync(databasePath(stateDir));
          database.exec(`
            PRAGMA user_version = 8;
            CREATE TABLE agent_databases (
              agent_id TEXT NOT NULL, path TEXT NOT NULL, schema_version INTEGER NOT NULL,
              last_seen_at INTEGER NOT NULL, size_bytes INTEGER,
              PRIMARY KEY (agent_id, path)
            );
          `);
          database.close();
        }
        for (const installRoot of new Set([packageRoot, readerPackageRoot])) {
          await writeFixture(
            installRoot,
            "package.json",
            '{"name":"openclaw","version":"2026.4.29"}\n',
          );
        }
        for (const [directory, name, content] of [
          [dependency, "package.json", '{"main":"index.cjs"}\n'],
          [dependency, "index.cjs", 'exports.value = "dependency-ready";\n'],
          [dependency, "late.cjs", 'exports.value = "dependency-survived";\n'],
          [
            mirror,
            "index.cjs",
            'exports.value = "mirror-ready"; exports.readLater = () => require("./late.cjs").value;\n',
          ],
          [mirror, "late.cjs", 'exports.value = "mirror-survived";\n'],
          [path.dirname(unknownFile), "keep.txt", "another consumer's files\n"],
        ] as const) {
          await writeFixture(directory, name, content);
        }
        await fs.symlink(dependency, alias, "junction");
        const readerFile = path.join(tempDir, "runtime-reader.cjs");
        await fs.writeFile(
          readerFile,
          `const { DatabaseSync } = require("node:sqlite");
const { createRequire } = require("node:module");
const [databasePath, packageRoot, modulePath] = process.argv.slice(2);
const database = new DatabaseSync(databasePath, { readOnly: true });
const fromInstall = createRequire(require("node:path").join(packageRoot, "index.cjs"));
const mirror = require(modulePath);
const version = () => database.prepare("PRAGMA user_version").get().user_version;
process.on("message", (message) => {
  if (message === "close") {
    database.close();
    process.disconnect();
    return;
  }
  try {
    process.send({ kind: "read", version: version(), dependency: fromInstall("fixture-runtime-dependency/late.cjs").value, mirror: mirror.readLater() });
  } catch (error) {
    process.send({ kind: "read", version: version(), errorCode: error.code });
  }
});
process.send({ kind: "ready", version: version(), dependency: fromInstall("fixture-runtime-dependency").value, mirror: mirror.value });
`,
        );
        const reader = fork(
          readerFile,
          [databasePath(stateB), readerPackageRoot, path.join(mirror, "index.cjs")],
          {
            cwd: stateB,
            execArgv: [],
            env: runtimeEnv(stateB),
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          },
        );
        const closed = once(reader, "close");
        const nextMessage = () =>
          Promise.race([
            once(reader, "message").then((messages: unknown[]) => messages[0]),
            closed.then(([code, signal]) => {
              throw new Error(`runtime reader exited before replying: ${code}/${signal}`);
            }),
          ]);
        try {
          await expect(nextMessage()).resolves.toEqual({
            kind: "ready",
            version: 8,
            dependency: "dependency-ready",
            mirror: "mirror-ready",
          });
          await fs.writeFile(
            path.join(packageRoot, "package.json"),
            '{"name":"openclaw","version":"2026.8.1"}\n',
          );
          await runDoctorRepairSequence({
            state: { cfg: {}, candidate: {}, pendingChanges: false, fixHints: [] },
            doctorFixCommand: "openclaw doctor --fix",
            env: runtimeEnv(stateA),
          });
          const response = nextMessage();
          reader.send("read");
          await expect(response).resolves.toEqual({
            kind: "read",
            version: 8,
            dependency: "dependency-survived",
            mirror: "mirror-survived",
          });
          expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
          expect(await fs.readFile(unknownFile, "utf8")).toBe("another consumer's files\n");
        } finally {
          if (reader.connected) {
            reader.send("close");
          }
          await expect(closed).resolves.toEqual([0, null]);
        }
      },
    );
  });
}
