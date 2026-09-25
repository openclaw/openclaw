import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitForDead, waitForPidFile } from "../../test/helpers/process-wait.js";
import * as commands from "../process/exec.js";
import { runCommandBuffered, runUtf8CommandWithTimeout } from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { prepareUpdateCandidateStateSnapshot } from "./update-candidate-snapshot.js";
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
    const stagingRoot = mode === "snapshot" ? input.targetStateDir : path.join(cache, "openclaw");
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
    // Fault this child's copied payload removal, leaving copy/read/cleanup owners intact.
    await fs.writeFile(
      preload,
      `
      import fs from "node:fs";
      import path from "node:path";
      const removeSync = fs.rmSync;
      const removeAsync = fs.promises.rm;
      const stagingRoot = ${JSON.stringify(stagingRoot)};
      const attemptsPath = ${JSON.stringify(attemptsPath)};
      const fault = ${JSON.stringify(scenario.cleanup)};
      let attempts = 0;
      const prepareRemoval = (location) => {
        const snapshot = String(location);
        const directory = path.dirname(snapshot);
        if (path.dirname(directory) !== stagingRoot ||
            path.basename(snapshot) !== "database.sqlite") {
          return undefined;
        }
        attempts++;
        const before = fs.existsSync(snapshot);
        const fail = fault === "persistent" || (fault === "transient" && attempts === 1);
        return { directory, snapshot, before, fail };
      };
      const recordRemoval = ({ directory, snapshot, before, fail }) => {
        fs.appendFileSync(attemptsPath, JSON.stringify({directory, before, after: fs.existsSync(snapshot), failed: fail}) + "\\n");
        if (fail) throw Object.assign(new Error("owned snapshot removal denied"), {code: "EACCES"});
      };
      fs.rmSync = (location, options) => {
        const attempt = prepareRemoval(location);
        if (!attempt) return removeSync(location, options);
        if (!attempt.fail) removeSync(location, options);
        recordRemoval(attempt);
      };
      fs.promises.rm = async (location, options) => {
        const attempt = prepareRemoval(location);
        if (!attempt) return removeAsync(location, options);
        if (!attempt.fail) await removeAsync(location, options);
        recordRemoval(attempt);
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
    expect(await fs.readFile(source)).toEqual(sourceBytes);
    expect(await fs.readdir(path.dirname(source))).toEqual(sourceEntries);
    expect(await fs.readFile(sentinel, "utf8")).toBe("unrelated preserved");
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
    const retained = (await fs.readdir(stagingRoot)).filter((name) =>
      name.startsWith("openclaw-sqlite-readonly-"),
    );
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
        expect(recorded?.detail).toMatch(
          /^Exit code: 1; (?:Caused by: )?no such column: "path".* \| ERR_SQLITE_ERROR$/u,
        );
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
): Awaited<ReturnType<typeof runUtf8CommandWithTimeout>> {
  return {
    stdout: error ? "" : JSON.stringify(value),
    stderr: error ?? "",
    code: error ? 1 : 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

it.each([false, true].flatMap((legacy) => [false, true].map((expires) => ({ legacy, expires }))))(
  "budgets the discovered registry inventory (legacy=$legacy, expires=$expires)",
  async ({ legacy, expires }) => {
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
    const calls: Array<[string[], commands.CommandOptions]> = [];
    const inspecting = createDeferredCore<AbortSignal>();
    const release = createDeferredCore();
    const run = commands.runUtf8CommandWithTimeout;
    vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv.includes("--eval")) {
        return run(argv, options);
      }
      if (typeof options === "number") {
        throw new Error("Schema inspection has no owned command options");
      }
      calls.push([argv, options]);
      if (legacy && calls.length === 1) {
        options.onOutputChunk?.(Buffer.from("Unknown update state inspection mode"), "stderr");
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
      if (!options?.signal) {
        throw new Error("Schema inspection has no owner watchdog signal");
      }
      inspecting.resolve(options.signal);
      await release.promise;
      return inspectionResult([sharedVersion, { path: external, userVersion: 7 }]);
    });

    const now = Date.now.bind(Date);
    let elapsed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
    const operation = readUpdateStateSchemaVersions({ stateDir, config: {} });
    const outcome = operation.then(
      (versions) => ({ versions }),
      (error: unknown) => ({ error }),
    );
    try {
      const signal = await Promise.race([
        inspecting.promise,
        operation.then(() => {
          throw new Error("Schema inspection completed before its held worker response");
        }),
      ]);
      // Modern inspection needs the external WAL bytes; legacy also needs shared's startup floor.
      elapsed = legacy ? 4_700_000 : 4_500_000;
      expect(signal.aborted).toBe(false);
      if (expires) {
        const aborted = new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        elapsed += 400_000;
        await aborted;
        expect(signal.aborted).toBe(true);
      }
      const stagingRoot = String(calls.at(-1)?.[1]?.env?.XDG_CACHE_HOME);
      expect(fsSync.existsSync(stagingRoot)).toBe(true);
      release.resolve();
      if (expires) {
        expect(await outcome).toMatchObject({
          error: {
            message: expect.stringContaining(
              `made no progress for ${legacy ? 4_841 : 4_540} seconds`,
            ),
          },
        });
      } else {
        await expect(operation).resolves.toContainEqual({ path: external, userVersion: 7 });
      }
      expect(calls).toHaveLength(legacy ? 3 : 2);
      for (const [, options] of calls) {
        expect(options).toMatchObject({ killGraceMs: 500 });
        expect(options?.timeoutMs).toBeUndefined();
        expect(fsSync.existsSync(String(options?.env?.XDG_CACHE_HOME))).toBe(false);
      }
    } finally {
      release.resolve();
      vi.useRealTimers();
      await outcome;
    }
  },
);

it.each(["versions array", "output limit", "non-exit"] as const)(
  "rejects %s as completed discovery",
  async (failure) => {
    const run = commands.runUtf8CommandWithTimeout;
    const worker = vi
      .spyOn(commands, "runUtf8CommandWithTimeout")
      .mockImplementation((argv, options) => {
        if (argv.includes("--eval")) {
          return run(argv, options);
        }
        const result = inspectionResult(
          failure === "versions array"
            ? []
            : { files: [], sharedVersion: { path: "shared.sqlite", userVersion: null } },
        );
        return Promise.resolve({
          ...result,
          ...(failure === "output limit" ? { outputLimitExceeded: true } : {}),
          ...(failure === "non-exit" ? { termination: "signal" as const } : {}),
        });
      });
    await expect(
      readUpdateStateSchemaVersions({
        stateDir: path.join(root, "invalid-discovery"),
        config: {},
      }),
    ).rejects.toThrow();
    expect(worker.mock.calls.filter(([argv]) => !argv.includes("--eval"))).toHaveLength(1);
  },
);

it("keeps fleet progress below a released parent's stderr limit", async () => {
  const entries = Object.fromEntries(
    Array.from(
      { length: 100 },
      (_, index) =>
        [
          `agent-${index}`,
          { agentDir: path.join(root, `external-${index}-${"x".repeat(100)}`) },
        ] as const,
    ),
  );
  const result = await runCommandBuffered(
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
      ),
    ],
    {
      input: JSON.stringify({ mode: "versions", stateDir: root, config: { agents: { entries } } }),
      timeoutMs: 30_000,
      killGraceMs: 500,
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
    },
  );
  expect(result.code, result.stderr.toString()).toBe(0);
  expect(result.stderr.byteLength).toBeLessThan(20_000);
  expect(result.stderr.toString()).toContain("detailed progress omitted");
  expect(JSON.parse(result.stdout.toString())).toContainEqual({
    path: path.join(entries["agent-99"]!.agentDir, "openclaw-agent.sqlite"),
    userVersion: null,
  });
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
import { spawnSync } from "node:child_process";
// Metadata probes use the real core program; only the schema worker should hang.
if (process.argv.includes("--eval")) {
  process.exit(spawnSync(process.execPath, process.argv.slice(2), { stdio: "inherit" }).status ?? 1);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
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
      const cancellation = new Error("test cancellation");
      controller.abort(cancellation);
      await expect(operation).rejects.toBe(cancellation);
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

it.each(["cancel", "deadline", "disk-full", "cooperative-cancel"] as const)(
  "settles the actual rehearsal backup child before removing scratch on %s",
  async (failure) => {
    const stateDir = path.join(root, "backup-failure");
    const source = path.join(stateDir, "state", "openclaw.sqlite");
    await createDatabase(
      source,
      "CREATE TABLE witness(value TEXT); INSERT INTO witness VALUES ('committed');",
    );
    const ready = path.join(root, "backup-ready.json");
    const preload = path.join(root, "backup-fault.cjs");
    await fs.writeFile(
      preload,
      `
      const fs = require("node:fs"), sqlite = require("node:sqlite");
      if (${JSON.stringify(failure)} !== "cooperative-cancel") process.on("SIGTERM", () => {});
      sqlite.backup = async function(source, destination) {
        fs.writeFileSync(destination, "partial private backup");
        fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, destination }));
        if (${JSON.stringify(failure)} === "disk-full") {
          throw Object.assign(new Error("synthetic destination full"), { code: "ERR_SQLITE_ERROR", errcode: 13 });
        }
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      };
    `,
    );
    const now = Date.now.bind(Date);
    let elapsed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
    const controller = new AbortController();
    const operation = prepareUpdateCandidateStateSnapshot({
      config: {},
      stateDir,
      candidateRoot: root,
      env: { TMPDIR: root },
      workerEnv: () => ({
        ...process.env,
        NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
        XDG_CACHE_HOME: path.join(root, "unowned-cache"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      }),
      signal: controller.signal,
    });
    const outcome = operation.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await expect
        .poll(async () => fs.readFile(ready, "utf8").catch(() => ""), { timeout: 10_000 })
        .not.toBe("");
      const child = JSON.parse(await fs.readFile(ready, "utf8")) as {
        pid: number;
        destination: string;
      };
      const scratch = path.dirname(path.dirname(child.destination));
      // SQLite can publish an extended-length Windows path for the same scratch parent.
      expect(path.toNamespacedPath(path.dirname(scratch))).toBe(path.toNamespacedPath(root));
      expect(path.basename(scratch)).toMatch(/^openclaw-update-canary-/);
      if (failure === "cancel" || failure === "cooperative-cancel") {
        controller.abort(new Error("cancel rehearsal proof"));
      } else if (failure === "deadline") {
        elapsed = 600_000;
      }
      const result = await outcome;
      expect(result).toMatchObject({ error: expect.any(Error) });
      if ("error" in result) {
        expect(String(result.error)).toContain(
          failure === "cancel" || failure === "cooperative-cancel"
            ? "cancel rehearsal proof"
            : failure === "deadline"
              ? "made no progress"
              : "synthetic destination full",
        );
      }
      await waitForDead(child.pid, 5_000);
      // Both cooperative and forced termination confirm this owned process tree is gone.
      await expect(fs.stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(root)).not.toContain("unowned-cache");
      const db = openNodeSqliteDatabase(source, { readOnly: true });
      try {
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(db.prepare("SELECT value FROM witness").get()).toEqual({ value: "committed" });
      } finally {
        db.close();
      }
    } finally {
      controller.abort();
      await outcome;
    }
  },
  20_000,
);
