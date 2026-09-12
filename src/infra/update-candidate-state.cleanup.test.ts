import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitForDead, waitForPidFile } from "../../test/helpers/process-wait.js";
import * as commands from "../process/exec.js";
import { runCommandBuffered } from "../process/exec.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  discoverUpdateStateSchemaInspectionInProcess,
  readUpdateStateSchemaVersions,
} from "./update-candidate-state.js";
import { inventoryUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-cleanup-")));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function createDatabase(file: string, sql = ""): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const db = openNodeSqliteDatabase(file);
  try {
    db.exec(`PRAGMA user_version = 3; ${sql}`);
  } finally {
    db.close();
  }
}

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

it("releases the shared discovery snapshot before agent inspection", async () => {
  const stateDir = path.join(root, "discovery-owner");
  const shared = path.join(stateDir, "state", "openclaw.sqlite");
  const agent = path.join(stateDir, "agents", "registered.sqlite");
  const stagingRoot = path.join(root, "discovery-staging");
  await createDatabase(
    shared,
    `CREATE TABLE agent_databases (path TEXT); INSERT INTO agent_databases VALUES ('${agent.replaceAll("'", "''")}');`,
  );
  await createDatabase(agent);
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });

  await expect(
    discoverUpdateStateSchemaInspectionInProcess({ stateDir, config: {}, stagingRoot }),
  ).resolves.toMatchObject({
    files: expect.arrayContaining([
      [shared, { spellings: [shared] }],
      [agent, { spellings: [agent] }],
    ]),
    sharedVersion: { path: shared, userVersion: 3, contentVersion: 3 },
  });
  expect(await fs.readdir(stagingRoot)).toEqual([]);
});

it.each([false, true])(
  "removes parent-owned schema staging after worker settlement (readError=%s)",
  async (readError) => {
    const cache = path.join(root, "inspection-cache");
    const cacheOwner = path.join(cache, "openclaw");
    const stateDir = path.join(root, `cleanup-${readError}`);
    const shared = path.join(stateDir, "state", "openclaw.sqlite");
    await fs.mkdir(cacheOwner, { recursive: true, mode: 0o700 });
    await createDatabase(shared, readError ? "CREATE TABLE agent_databases (not_path TEXT);" : "");
    const previousCache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cache;
    try {
      const operation = readUpdateStateSchemaVersions({ stateDir, config: {} });
      if (readError) {
        await expect(operation).rejects.toThrow('no such column: "path"');
      } else {
        await expect(operation).resolves.toContainEqual({
          path: shared,
          userVersion: 3,
          contentVersion: 3,
        });
      }
      expect(await fs.readdir(cacheOwner)).toEqual([]);
    } finally {
      if (previousCache === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = previousCache;
      }
    }
  },
);

function inspectionResult(
  value: unknown,
  error?: string,
): Awaited<ReturnType<typeof runCommandBuffered>> {
  return {
    stdout: Buffer.from(error ? "" : JSON.stringify(value)),
    stderr: Buffer.from(error ?? ""),
    code: error ? 1 : 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

it.each([false, true])("budgets the discovered registry inventory (legacy=%s)", async (legacy) => {
  const stateDir = path.join(root, "inspection-budget");
  const shared = path.join(stateDir, "state", "openclaw.sqlite");
  const external = path.join(root, "registry-only", "agent.sqlite");
  await fs.mkdir(path.dirname(shared), { recursive: true });
  await fs.mkdir(path.dirname(external), { recursive: true });
  const database = openNodeSqliteDatabase(shared);
  database.exec("PRAGMA user_version = 3; CREATE TABLE agent_databases (path TEXT);");
  database.prepare("INSERT INTO agent_databases VALUES (?)").run(external);
  database.close();
  await fs.writeFile(external, "");
  await fs.truncate(external, 3_489_660_928);
  await fs.writeFile(`${external}-wal`, "");
  await fs.truncate(`${external}-wal`, 64 * 1024 * 1024);
  const sharedVersion = { path: shared, userVersion: 3, contentVersion: 3 };
  const discovery = {
    files: [
      [shared, { spellings: [shared] }],
      [external, { spellings: [external] }],
    ],
    sharedVersion,
  };
  const calls: Array<Parameters<typeof runCommandBuffered>> = [];
  const run = commands.runCommandBuffered;
  vi.spyOn(commands, "runCommandBuffered").mockImplementation(async (argv, options) => {
    if (argv.includes("--eval")) {
      return run(argv, options);
    }
    calls.push([argv, options]);
    if (legacy && calls.length === 1) {
      return inspectionResult(null, "Unknown update state inspection mode");
    }
    if (legacy && calls.length === 2) {
      const location = path.join(String(options?.env?.XDG_CACHE_HOME), "database.sqlite");
      fsSync.copyFileSync(shared, location);
      return inspectionResult({ ok: true, location });
    }
    if (!legacy && calls.length === 1) {
      return inspectionResult(discovery);
    }
    return inspectionResult([sharedVersion, { path: external, userVersion: 7 }]);
  });

  await expect(readUpdateStateSchemaVersions({ stateDir, config: {} })).resolves.toContainEqual({
    path: external,
    userVersion: 7,
  });
  expect(calls).toHaveLength(legacy ? 3 : 2);
  expect(calls[0]?.[1]?.timeoutMs).toBe(31_000);
  // 134 seconds for the database plus 2 for its WAL; legacy also recopies shared.
  expect(calls.at(-1)?.[1]?.timeoutMs).toBe(legacy ? 167_000 : 136_000);
  for (const [, options] of calls) {
    expect(options).toMatchObject({ killGraceMs: 500 });
    expect(fsSync.existsSync(String(options?.env?.XDG_CACHE_HOME))).toBe(false);
  }
});

it("rejects a versions array as a discovery response", async () => {
  const run = commands.runCommandBuffered;
  const worker = vi
    .spyOn(commands, "runCommandBuffered")
    .mockImplementation((argv, options) =>
      argv.includes("--eval") ? run(argv, options) : Promise.resolve(inspectionResult([])),
    );
  await expect(
    readUpdateStateSchemaVersions({
      stateDir: path.join(root, "invalid-discovery"),
      config: {},
    }),
  ).rejects.toThrow();
  expect(worker.mock.calls.filter(([argv]) => !argv.includes("--eval"))).toHaveLength(1);
});

it.runIf(process.platform !== "win32")(
  "kills a cancelled schema worker before removing its parent-owned staging root",
  async () => {
    const cache = path.join(root, "kill-cache");
    const cacheOwner = path.join(cache, "openclaw");
    const pidPath = path.join(root, "hung-worker.pid");
    const stagingPath = path.join(root, "hung-worker-staging.txt");
    const runner = path.join(root, "hung-worker.mjs");
    await fs.mkdir(cacheOwner, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      runner,
      `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
// This fixture has no source databases; only the schema worker should hang.
if (process.argv.includes("--eval")) {
  console.log("[]");
  process.exit(0);
}
const { stagingRoot } = JSON.parse(input);
fs.mkdirSync(path.join(stagingRoot, "partial"), { recursive: true });
fs.writeFileSync(path.join(stagingRoot, "partial", "database.sqlite"), "partial");
fs.writeFileSync(${JSON.stringify(stagingPath)}, stagingRoot);
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 60_000);
`,
      { mode: 0o755 },
    );
    const previousCache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cache;
    const controller = new AbortController();
    try {
      const operation = readUpdateStateSchemaVersions({
        stateDir: path.join(root, "unused-state"),
        config: {},
        nodeRunner: runner,
        signal: controller.signal,
      });
      const pid = await waitForPidFile(pidPath, 5_000);
      controller.abort(new Error("test cancellation"));
      await expect(operation).rejects.toThrow(/signal SIGKILL/u);
      await waitForDead(pid, 5_000);
      const stagingRoot = await fs.readFile(stagingPath, "utf8");
      await expect(fs.stat(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(cacheOwner)).toEqual([]);
    } finally {
      if (previousCache === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = previousCache;
      }
    }
  },
);
