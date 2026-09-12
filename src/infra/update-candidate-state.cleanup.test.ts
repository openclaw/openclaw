import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCommandBuffered } from "../process/exec.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { inventoryUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-cleanup-")));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const cases = [
  { cleanup: "healthy", readError: false },
  { cleanup: "transient", readError: false },
  { cleanup: "persistent", readError: false },
  { cleanup: "healthy", readError: true },
  { cleanup: "persistent", readError: true },
] as const;

it.each(
  (["versions", "snapshot"] as const).flatMap((mode) =>
    cases.map(({ cleanup, readError }) => ({ mode, cleanup, readError })),
  ),
)(
  "$mode: $cleanup cleanup with readError=$readError",
  async (scenario) => {
    const { mode } = scenario;
    const fixture = path.join(root, `${scenario.cleanup}-${scenario.readError}`);
    const stateDir = path.join(fixture, "source");
    const source = path.join(stateDir, "state", "openclaw.sqlite");
    const cache = path.join(fixture, "cache");
    const attemptsPath = path.join(fixture, "attempts.jsonl");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(cache);
    const db = openNodeSqliteDatabase(source);
    try {
      db.exec(
        "PRAGMA user_version = 3; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('source preserved');",
      );
      if (scenario.readError && mode === "versions") {
        db.exec("CREATE TABLE agent_databases (not_path TEXT);");
      }
    } finally {
      db.close();
    }
    const input = {
      stateDir,
      targetStateDir: path.join(fixture, "candidate"),
      candidateRoot: path.join(fixture, "package"),
      config: {},
    };
    const admitted =
      mode === "snapshot" ? await inventoryUpdateCandidateStateWorker(input) : undefined;
    if (scenario.readError && mode === "snapshot") {
      // Inventory succeeds first; the instrumented snapshot owns the failed read and cleanup.
      const malformed = openNodeSqliteDatabase(source);
      try {
        malformed.exec("CREATE TABLE agent_databases (not_path TEXT);");
      } finally {
        malformed.close();
      }
    }
    const sentinel = path.join(cache, "unrelated.txt");
    await fs.writeFile(sentinel, "unrelated preserved");
    const sourceBytes = await fs.readFile(source);
    const sourceEntries = await fs.readdir(path.dirname(source));
    const preload = path.join(fixture, "deletion-fault.mjs");
    // Fault only this child's raw snapshot, leaving actual copy/read/cleanup owners intact.
    await fs.writeFile(
      preload,
      `
      import fs from "node:fs";
      import path from "node:path";
      const remove = fs.rmSync;
      const cache = ${JSON.stringify(cache)};
      const attemptsPath = ${JSON.stringify(attemptsPath)};
      const fault = ${JSON.stringify(scenario.cleanup)};
      let attempts = 0;
      fs.rmSync = (location, options) => {
        const directory = String(location);
        if (path.dirname(directory) !== path.join(cache, "openclaw") ||
            !path.basename(directory).startsWith("openclaw-sqlite-readonly-" + process.pid + "-")) {
          return remove(location, options);
        }
        attempts++;
        const snapshot = path.join(directory, "database.sqlite");
        const before = fs.existsSync(snapshot);
        const fail = fault === "persistent" || (fault === "transient" && attempts === 1);
        if (!fail) remove(location, options);
        fs.appendFileSync(attemptsPath, JSON.stringify({directory, before, after: fs.existsSync(snapshot), failed: fail}) + "\\n");
        if (fail) throw Object.assign(new Error("owned snapshot removal denied"), {code: "EACCES"});
      };
    `,
    );
    const result = await runCommandBuffered(
      [
        process.execPath,
        "--import",
        pathToFileURL(preload).href,
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
        ),
      ],
      {
        input: JSON.stringify({
          mode,
          ...input,
          ...admitted,
        }),
        env: { XDG_CACHE_HOME: cache },
        timeoutMs: 30_000,
        killGraceMs: 500,
        maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
      },
    );
    const attempts = (await fs.readFile(attemptsPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            directory: string;
            before: boolean;
            after: boolean;
            failed: boolean;
          },
      );
    const retained = await fs.readdir(path.join(cache, "openclaw"));
    console.log(
      JSON.stringify({
        ...scenario,
        code: result.code,
        termination: result.termination,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        attempts,
        retained,
      }),
    );
    expect(await fs.readFile(source)).toEqual(sourceBytes);
    expect(await fs.readdir(path.dirname(source))).toEqual(sourceEntries);
    expect(await fs.readFile(sentinel, "utf8")).toBe("unrelated preserved");
    expect(attempts).toHaveLength(scenario.cleanup === "healthy" ? 1 : 2);
    expect(attempts.every((attempt) => attempt.before)).toBe(true);
    expect(attempts.at(-1)?.after).toBe(scenario.cleanup === "persistent");
    expect(retained).toHaveLength(scenario.cleanup === "persistent" ? 1 : 0);
    if (scenario.cleanup === "healthy" && !scenario.readError) {
      expect(result.code, result.stderr.toString()).toBe(0);
      const output = JSON.parse(result.stdout.toString());
      expect(mode === "versions" ? output : output.versions).toContainEqual({
        path: source,
        userVersion: 3,
        contentVersion: 3,
      });
    } else {
      expect(result.code, result.stdout.toString()).toBe(1);
      expect(result.stdout.toString()).toBe("");
      if (scenario.readError) {
        expect(result.stderr.toString()).toContain('no such column: "path"');
        const [recorded] = updateRunStepsFromResultStep({
          name: "candidate snapshot",
          exitCode: result.code,
          stderrTail: result.stderr.toString(),
        });
        expect(recorded?.detail).toContain("ERR_SQLITE_ERROR");
        expect(recorded?.detail).toContain('no such column: "path"');
        expect(recorded?.detail?.length).toBeLessThanOrEqual(300);
      }
      if (scenario.cleanup !== "healthy") {
        expect(result.stderr.toString()).toContain("snapshot cleanup failed");
        expect(result.stderr.toString()).toContain(attempts[0]!.directory);
      }
    }
  },
  30_000,
);
