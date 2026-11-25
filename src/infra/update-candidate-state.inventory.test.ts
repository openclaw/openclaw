import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, beforeEach, describe, vi } from "vitest";
import { expectBytesEqual } from "../../test/helpers/file-snapshots.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCronStoreSelectionInDatabase } from "../cron/store/paths.js";
import { runCommandBuffered } from "../process/exec.js";
import { AGENT_FTS_SCHEMAS } from "../state/openclaw-agent-fts-schema.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withStateMigrationBackupForTest } from "../state/openclaw-state-schema.test-support.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { installSqliteFtsTokenizerMismatch } from "./sqlite-index-corruption.test-support.js";
import { LegacyMigrationSourceClaim } from "./state-migrations.source-snapshot.js";
import {
  UPDATE_CANDIDATE_PLUGIN_PLAN_FILENAME,
  resolveUpdateCandidateStatePath,
} from "./update-candidate-paths.js";
import {
  createUpdateStateInspectionDiagnostics,
  type UpdateStateInspectionProgress,
} from "./update-candidate-state.diagnostics.js";
import {
  UpdateCandidateSnapshotInventorySchema,
  collectStateDatabasePaths,
  readUpdateCandidateStateInventoryInProcess,
  snapshotUpdateCandidateState,
} from "./update-candidate-state.js";
import {
  createStateSnapshotInput,
  runUpdateCandidateSnapshotWorker,
} from "./update-candidate-state.test-support.js";

async function resizeFile(file: string, size: number, flag: "w" | "a") {
  const handle = await fs.open(file, flag);
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}

describe("snapshot inventory", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it("queues retained custom shared-state roots for exact capture with plugins disabled", async () => {
    const root = dirs.make("candidate-shared-roots-");
    const stateDir = path.join(root, "selected");
    const external = path.join(root, "external");
    for (const parent of [path.join(stateDir, "voice-calls"), external]) {
      const file = path.join(parent, "state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "");
    }
    const discovered = await collectStateDatabasePaths(
      {
        stateDir,
        config: {
          plugins: {
            enabled: false,
            entries: {
              "voice-call": { enabled: false, config: { store: external } },
              "@openclaw/voice-call": { config: { store: "~/retained-calls" } },
            },
          },
        },
        env: { HOME: root, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      },
      { includeUnconfiguredAgents: false },
    );
    const shared = path.join(stateDir, "state", "openclaw.sqlite");
    expect(discovered.get(shared)).toEqual({ spellings: [shared], owners: [{ role: "global" }] });
    for (const parent of [path.join(stateDir, "voice-calls"), external]) {
      const file = path.join(parent, "state", "openclaw.sqlite");
      expect(discovered.get(file)).toEqual({ spellings: [file] });
    }
    expect(discovered.has(path.join(root, "retained-calls", "state", "openclaw.sqlite"))).toBe(
      false,
    );
  });

  it.each([
    "missing plugin dependency",
    "missing plugin dependency in WAL",
    "install record",
    "locator symlink",
    "database registration",
    "added file",
    "enlarged file",
  ])("keeps snapshot boundaries and failure attribution after %s changes", async (change) => {
    const root = dirs.make("candidate-inventory-drift-");
    const stateDir = path.join(root, "source");
    const inventoryRoot = path.join(root, "inventory");
    const targetStateDir = path.join(root, "snapshot");
    const candidateRoot = path.join(root, "candidate");
    await fs.mkdir(inventoryRoot);
    await fs.mkdir(candidateRoot);
    await fs.writeFile(path.join(candidateRoot, "package.json"), '{"name":"openclaw"}');
    const writePlugin = async (project: string, size: number) => {
      const relative = path.join("npm", "projects", project, "node_modules", "@example", "demo");
      const directory = path.join(stateDir, relative);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "package.json"), '{"name":"@example/demo"}');
      await fs.writeFile(path.join(directory, "index.js"), "export default {};\n");
      await resizeFile(path.join(directory, "payload.bin"), size, "w");
      return { directory, relative };
    };
    const initial = await writePlugin("initial", 4096);
    const larger = await writePlugin("larger", 16 * 1024 * 1024);
    const locator = path.join(stateDir, "extensions", "demo");
    if (change === "locator symlink") {
      await fs.mkdir(path.dirname(locator));
      await fs.symlink(initial.directory, locator, "junction");
    }
    const env = { HOME: root, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const shared = path.join(stateDir, "state", "openclaw.sqlite");
    const setRecord = (installPath: string) => {
      const db = openOpenClawStateDatabase({ env }).db;
      db.prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, 1) ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json",
      ).run(
        "plugins.installedIndex",
        JSON.stringify({
          revision: 1,
          index: {
            installRecords: {
              demo: { source: "npm", spec: "@example/demo@1.0.0", installPath },
            },
          },
        }),
      );
      closeOpenClawStateDatabaseByPath(shared);
    };
    setRecord(change === "locator symlink" ? locator : initial.directory);
    let databaseInventory: string[] = [];
    const run = async (mode: "inventory" | "snapshot") => {
      const progress: UpdateStateInspectionProgress[] = [];
      const diagnostics = createUpdateStateInspectionDiagnostics({
        operation: "State snapshot",
        phase: mode,
        paths: [stateDir],
        onProgress: (value) => progress.push(value),
      });
      const result = await runCommandBuffered(
        [
          process.execPath,
          ...resolveRuntimeWorkerArgv(
            resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
          ),
        ],
        {
          input: JSON.stringify({
            mode,
            stateDir,
            targetStateDir: mode === "inventory" ? inventoryRoot : targetStateDir,
            candidateRoot,
            config: {},
            env,
            databaseInventory,
            pluginPlanPath: path.join(inventoryRoot, UPDATE_CANDIDATE_PLUGIN_PLAN_FILENAME),
          }),
          timeoutMs: 30_000,
          killGraceMs: 500,
          maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
        },
      );
      diagnostics.onOutputChunk(result.stderr, "stderr");
      return { ...result, diagnostics, progress };
    };
    const expectFailurePhase = (
      result: Awaited<ReturnType<typeof run>>,
      phase: string,
      source = stateDir,
    ) => {
      const message = result.diagnostics.failure(
        result.diagnostics.stderr() || result.stderr.toString("utf8"),
        result.termination,
      ).message;
      expect(message).toContain(`during ${phase} for ${source} (scope:`);
      expect(message).toContain("source paths");
      expect(message).toContain("Check access to the reported source");
      expect(message).not.toContain("Check database access");
    };
    if (change.startsWith("missing plugin dependency")) {
      // An external missing target must fail inventory rather than survive as an internal link.
      await fs.symlink(
        path.join(root, "missing-dependency"),
        path.join(path.dirname(initial.directory), "missing"),
        "junction",
      );
      using db = openNodeSqliteDatabase(shared);
      db.exec(
        change.endsWith("WAL")
          ? "PRAGMA journal_mode=WAL; CREATE TABLE committed_wal(value);"
          : "PRAGMA journal_mode=DELETE;",
      );
      const sourceDatabase = await fs.readFile(shared);
      const wal = change.endsWith("WAL") ? await fs.readFile(`${shared}-wal`) : undefined;
      const inventoried = await run("inventory");
      expect(inventoried.code).not.toBe(0);
      expect(inventoried.stderr.toString("utf8")).toContain(
        "Cannot privately copy plugin dependency",
      );
      // Metadata inventory must not copy the whole store before discovering this failure.
      expect(inventoried.progress.some((progress) => progress.snapshot !== undefined)).toBe(false);
      expect((await fs.readFile(shared)).equals(sourceDatabase)).toBe(true);
      if (wal) {
        expect(await fs.readFile(`${shared}-wal`)).toEqual(wal);
      }
      expectFailurePhase(inventoried, "plugin inventory");
      return;
    }
    const inventoried = await run("inventory");
    expect(inventoried.code, inventoried.stderr.toString("utf8")).toBe(0);
    const inventory = UpdateCandidateSnapshotInventorySchema.parse(
      JSON.parse(inventoried.stdout.toString("utf8")),
    );
    databaseInventory = [...inventory.databases.keys()];
    expect(inventory.pluginBytes).toBeLessThan(16 * 1024 * 1024);
    let largerCopyPath = path.join(targetStateDir, larger.relative);
    if (change === "install record") {
      setRecord(larger.directory);
    } else if (change === "locator symlink") {
      await fs.unlink(locator);
      await fs.symlink(larger.directory, locator, "junction");
    } else if (change === "database registration") {
      const external = path.join(root, "late-agent.sqlite");
      const agentDb = openNodeSqliteDatabase(external);
      agentDb.exec(
        "PRAGMA user_version = 3; CREATE TABLE evidence(value BLOB); INSERT INTO evidence VALUES (zeroblob(16777216));",
      );
      agentDb.close();
      const registry = openOpenClawStateDatabase({ env }).db;
      registry
        .prepare(
          "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, 3, 0)",
        )
        .run("late", external);
      closeOpenClawStateDatabaseByPath(shared);
      largerCopyPath = path.join(
        resolveUpdateCandidateStatePath(stateDir, targetStateDir, path.dirname(external)),
        path.basename(external),
      );
    } else {
      const name = change === "added file" ? "late.bin" : "payload.bin";
      await resizeFile(path.join(initial.directory, name), 16 * 1024 * 1024, "a");
      largerCopyPath = path.join(targetStateDir, initial.relative, name);
    }
    const sourceDatabase = await fs.readFile(shared);
    const snapshot = await run("snapshot");
    const copiedNewOwner = await fs.access(largerCopyPath).then(
      () => true,
      () => false,
    );
    expect((await fs.readFile(shared)).equals(sourceDatabase)).toBe(true);
    if (change === "added file" || change === "locator symlink") {
      expect(snapshot.code, snapshot.stderr.toString("utf8")).toBe(0);
    } else {
      expect(snapshot.code, "snapshot must refuse uninventoried bytes").not.toBe(0);
      expect(snapshot.stderr.toString("utf8")).toContain(
        change === "enlarged file"
          ? "file exceeds limit of 4096 bytes (got 16777216)"
          : change === "install record"
            ? "Plugin record locator was not inventoried"
            : "changed after snapshot inventory",
      );
      expectFailurePhase(
        snapshot,
        change === "database registration" ? "database snapshot" : "plugin snapshot",
        change === "database registration" ? shared : stateDir,
      );
    }
    expect(copiedNewOwner).toBe(false);
  });
});

describe("snapshot legacy cron identity", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it.each(["original", "moved", "released envelope", "bound released envelope", "explicit config"])(
    "preserves only proven source cron partition selection (%s)",
    async (selector) => {
      const released = selector.includes("released envelope");
      const bound = selector === "bound released envelope";
      const root = await fs.realpath(dirs.make("candidate-cron-identity-"));
      const stateDir = path.join(root, "source");
      const targetStateDir = path.join(root, "rehearsal");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const source = openOpenClawStateDatabase({ env }).path;
      closeOpenClawStateDatabaseForTest();
      const configDir = path.join(root, "config");
      const storeKey = path.join(
        selector === "moved"
          ? path.join(root, "prior")
          : selector === "explicit config" || bound
            ? configDir
            : stateDir,
        "cron",
        "jobs.json",
      );
      {
        using db = openNodeSqliteDatabase(source);
        db.exec(`DELETE FROM config_machine_state WHERE state_key IN
        ('cron.defaultStoreKey', 'state.schema.contentVersion');
        UPDATE schema_meta SET schema_version = 33;
        PRAGMA user_version = 33;`);
        db.prepare(`INSERT INTO cron_job_scratch
        (store_key, job_id, content, revision, updated_at_ms) VALUES (?, 'retained', NULL, 1, 1)`).run(
          storeKey,
        );
        if (selector === "explicit config" || bound) {
          db.prepare(`INSERT INTO cron_job_scratch
          (store_key, job_id, content, revision, updated_at_ms) VALUES (?, 'custom', NULL, 1, 1)`).run(
            path.join(stateDir, "cron", "jobs.json"),
          );
        }
        if (bound) {
          db.prepare(`INSERT INTO config_machine_state
          (state_key, value_json, updated_at_ms) VALUES ('cron.defaultStoreKey', ?, 1)`).run(
            JSON.stringify(storeKey),
          );
        }
      }
      const original = await fs.readFile(source);
      const input = createStateSnapshotInput(root, stateDir, targetStateDir);
      if (released || selector === "explicit config") {
        vi.stubEnv("OPENCLAW_STATE_DIR", targetStateDir);
        vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(targetStateDir, "openclaw.json"));
      }
      await runUpdateCandidateSnapshotWorker({
        ...input,
        // Released parents omit source selectors and launch with the rehearsal environment.
        ...(released || selector === "explicit config"
          ? {
              env: {
                HOME: root,
                OPENCLAW_HOME: root,
                ...(selector === "explicit config"
                  ? { OPENCLAW_CONFIG_PATH: path.join(configDir, "openclaw.json") }
                  : {}),
              },
            }
          : {}),
      });
      const copiedEnv = { OPENCLAW_STATE_DIR: targetStateDir };
      const selection = await withStateMigrationBackupForTest({ env: copiedEnv }, () =>
        resolveCronStoreSelectionInDatabase(
          openOpenClawStateDatabase({ env: copiedEnv }).db,
          undefined,
          copiedEnv,
        ),
      );
      expect(selection).toMatchObject({ status: "ready", storeKey });
      expectBytesEqual(await fs.readFile(source), original, "source");
    },
  );
});

describe("snapshot execution approvals", () => {
  const dirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      vi.restoreAllMocks();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });
  let root: string;
  beforeEach(async () => {
    root = await fs.realpath(dirs.make("candidate-policy-"));
  });
  function runSnapshotWorker(
    input: Omit<Parameters<typeof runUpdateCandidateSnapshotWorker>[0], "candidateRoot">,
  ) {
    return runUpdateCandidateSnapshotWorker({
      ...input,
      candidateRoot: path.join(root, "candidate-host"),
    });
  }

  it.each(["", ".doctor-importing"])(
    "rehearses conflicting exec approvals from the copied policy%s without modifying source",
    async (suffix) => {
      const source = path.join(root, "source");
      const target = path.join(root, "copy");
      const env = { OPENCLAW_STATE_DIR: source };
      const { writeExecApprovalsConfigRow, readExecApprovalsConfigRow } =
        await import("./exec-approvals-sqlite.js");
      const { detectLegacyExecApprovals, migrateLegacyExecApprovals } =
        await import("./state-migrations.exec-approvals.js");
      const canonical = {
        version: 1 as const,
        defaults: { security: "deny" as const },
        agents: {},
      };
      const db = openOpenClawStateDatabase({ env }).db;
      writeExecApprovalsConfigRow({ db, file: canonical });
      const canonicalBefore = readExecApprovalsConfigRow(db)?.raw_json;
      closeOpenClawStateDatabaseForTest();
      const sourcePath = path.join(source, `exec-approvals.json${suffix}`);
      const raw = JSON.stringify({ version: 1, defaults: { security: "full" }, agents: {} });
      await fs.writeFile(sourcePath, raw);
      await runSnapshotWorker({ stateDir: source, targetStateDir: target, config: {} });
      const copiedPath = path.join(target, `exec-approvals.json${suffix}`);
      expect(await fs.readFile(copiedPath, "utf8")).toBe(raw);
      const copiedEnv = { OPENCLAW_STATE_DIR: target };
      const result = await migrateLegacyExecApprovals({
        stateDir: target,
        env: copiedEnv,
        detected: detectLegacyExecApprovals({ stateDir: target, doctorOnlyStateMigrations: true }),
      });
      expect(result.warnings.join(" ")).toContain("Conflicting legacy exec approvals remain");
      expect(result.changes).toEqual([]);
      expect(await fs.readFile(sourcePath, "utf8")).toBe(raw);
      expect(readExecApprovalsConfigRow(openOpenClawStateDatabase({ env }).db)?.raw_json).toBe(
        canonicalBefore,
      );
    },
  );

  it.each(["reappeared", "interrupted"])(
    "rehearses receipt-authorized legacy policy cleanup (%s)",
    async (sourceState) => {
      const source = path.join(root, "source");
      const target = path.join(root, "copy");
      const env = { OPENCLAW_STATE_DIR: source };
      const { writeExecApprovalsConfigRow } = await import("./exec-approvals-sqlite.js");
      const { detectLegacyExecApprovals, migrateLegacyExecApprovals } =
        await import("./state-migrations.exec-approvals.js");
      await fs.mkdir(source);
      const sourcePath = path.join(source, "exec-approvals.json");
      const interrupted = sourceState === "interrupted";
      const raw = JSON.stringify(
        interrupted
          ? {
              version: 1,
              agents: { main: { allowlist: [{ pattern: "/usr/bin/rg", lastUsedAt: null }] } },
            }
          : { version: 1, defaults: { security: "full" }, agents: {} },
      );
      await fs.writeFile(sourcePath, raw);
      if (interrupted) {
        vi.spyOn(LegacyMigrationSourceClaim.prototype, "remove").mockRejectedValueOnce(
          new Error("synthetic interrupted cleanup"),
        );
      }
      const imported = await migrateLegacyExecApprovals({
        stateDir: source,
        env,
        detected: detectLegacyExecApprovals({ stateDir: source, doctorOnlyStateMigrations: true }),
      });
      if (interrupted) {
        expect(imported.warnings.join(" ")).toContain("cleanup failed");
      } else {
        expect(imported.warnings).toEqual([]);
        expect(imported.changes.length).toBeGreaterThan(0);
        writeExecApprovalsConfigRow({
          db: openOpenClawStateDatabase({ env }).db,
          file: { version: 1, defaults: { security: "deny" }, agents: {} },
        });
      }
      closeOpenClawStateDatabaseForTest();
      // A reappearing imported source cannot undo a later policy edit.
      if (!interrupted) {
        await fs.writeFile(sourcePath, raw);
      }
      await runSnapshotWorker({ stateDir: source, targetStateDir: target, config: {} });
      const result = await migrateLegacyExecApprovals({
        stateDir: target,
        env: { OPENCLAW_STATE_DIR: target },
        detected: detectLegacyExecApprovals({ stateDir: target, doctorOnlyStateMigrations: true }),
      });
      expect(result.warnings).toEqual([]);
      if (interrupted) {
        expect(result.changes).toContain(
          "Completed cleanup for previously imported legacy exec approvals.",
        );
        await expect(
          fs.stat(path.join(target, "exec-approvals.json.doctor-importing")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(result.changes.length).toBeGreaterThan(0);
      }
      expect(
        await fs.readFile(`${sourcePath}${interrupted ? ".doctor-importing" : ""}`, "utf8"),
      ).toBe(raw);
    },
  );
});

describe("snapshot FTS integrity", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const ftsTables = ["memory_index_chunks_fts", "session_transcript_fts"];
  const malformed = ftsTables.map(
    (table) => `malformed inverted index for FTS5 table main.${table}`,
  );

  async function snapshotAgentDatabase(staleTables: readonly string[]) {
    const root = tempDirs.make("candidate-fts-");
    const stateDir = path.join(root, "source");
    const targetStateDir = path.join(root, "rehearsal");
    const relative = path.join("agents", "main", "agent", "openclaw-agent.sqlite");
    const source = path.join(stateDir, relative);
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(targetStateDir);
    {
      using db = openNodeSqliteDatabase(source);
      for (const match of AGENT_FTS_SCHEMAS.join("\n").matchAll(/CREATE VIRTUAL TABLE[^;]+;/gu)) {
        if (!match[0].includes("content =")) {
          db.exec(match[0]);
        }
      }
      for (const table of ftsTables) {
        db.exec(`INSERT INTO ${table}(text) VALUES ('ab'||char(65534)||'cd')`);
      }
      db.exec(`
        PRAGMA user_version = 3;
        CREATE VIRTUAL TABLE unowned_fts USING fts5(text);
        INSERT INTO unowned_fts(text) VALUES ('ab'||char(65534)||'cd');
      `);
    }
    for (const table of staleTables) {
      installSqliteFtsTokenizerMismatch(source, table);
    }
    const original = await fs.readFile(source);
    const input = createStateSnapshotInput(root, stateDir, targetStateDir);
    const inventory = await readUpdateCandidateStateInventoryInProcess(input);
    const snapshot = snapshotUpdateCandidateState({
      ...input,
      pluginPlanPath: path.join(targetStateDir, inventory.pluginPlan),
      databaseInventory: [...inventory.databases.keys()],
    });
    return { snapshot, original, source, target: path.join(targetStateDir, relative) };
  }

  it("rehearses a database whose only findings are stale owned FTS indexes", async () => {
    const { snapshot, original, source, target } = await snapshotAgentDatabase(ftsTables);
    await snapshot;
    const copy = openNodeSqliteDatabase(target, { readOnly: true });
    try {
      // The candidate's agent database admission owns the rebuild, not the snapshot.
      expect(copy.prepare("PRAGMA integrity_check").all()).toEqual(
        malformed.map((integrity_check) => ({ integrity_check })),
      );
      expect(copy.prepare("SELECT text FROM session_transcript_fts").all()).toEqual([
        { text: "ab\ufffecd" },
      ]);
    } finally {
      copy.close();
    }
    expect(await fs.readFile(source)).toEqual(original);
  });

  it("still refuses when a stale FTS index is not an owned definition", async () => {
    const { snapshot } = await snapshotAgentDatabase([...ftsTables, "unowned_fts"]);
    await expect(snapshot).rejects.toThrow(/cannot be snapshotted safely.*main\.unowned_fts/su);
  });
});
