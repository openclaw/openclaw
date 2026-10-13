import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, beforeEach, describe } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandBuffered } from "../process/exec.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
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
  readUpdateCandidateStateInventoryInProcess,
  snapshotUpdateCandidateState,
} from "./update-candidate-state.js";
import { runUpdateCandidateSnapshotWorker } from "./update-candidate-state.test-support.js";

describe("snapshot inventory", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it.each([
    "missing plugin dependency",
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
      const payload = await fs.open(path.join(directory, "payload.bin"), "w");
      try {
        await payload.truncate(size);
      } finally {
        await payload.close();
      }
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
    if (change === "missing plugin dependency") {
      // An external missing target must fail inventory rather than survive as an internal link.
      await fs.symlink(
        path.join(root, "missing-dependency"),
        path.join(path.dirname(initial.directory), "missing"),
        "junction",
      );
      const sourceDatabase = await fs.readFile(shared);
      const inventoried = await run("inventory");
      expect(inventoried.code).not.toBe(0);
      expect(inventoried.stderr.toString("utf8")).toContain(
        "Cannot privately copy plugin dependency",
      );
      expect(inventoried.progress).toContainEqual(
        expect.objectContaining({
          phase: "shared database snapshot",
          snapshot: expect.objectContaining({ status: "completed" }),
        }),
      );
      expect((await fs.readFile(shared)).equals(sourceDatabase)).toBe(true);
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
      const payload = await fs.open(path.join(initial.directory, name), "a");
      try {
        await payload.truncate(16 * 1024 * 1024);
      } finally {
        await payload.close();
      }
      largerCopyPath = path.join(targetStateDir, initial.relative, name);
    }
    const sourceDatabase = await fs.readFile(shared);
    const snapshot = await run("snapshot");
    const copiedNewOwner = await fs.access(largerCopyPath).then(
      () => true,
      () => false,
    );
    console.log(
      "Candidate plugin ownership drift",
      JSON.stringify({
        change,
        pluginBytes: inventory.pluginBytes,
        exitCode: snapshot.code,
        copiedNewOwner,
      }),
    );
    expect((await fs.readFile(shared)).equals(sourceDatabase)).toBe(true);
    if (change === "added file") {
      expect(snapshot.code, snapshot.stderr.toString("utf8")).toBe(0);
    } else {
      expect(snapshot.code, "snapshot must refuse uninventoried bytes").not.toBe(0);
      expect(snapshot.stderr.toString("utf8")).toContain("changed after snapshot inventory");
      expectFailurePhase(
        snapshot,
        change === "database registration" ? "database snapshot" : "plugin snapshot",
        change === "database registration" ? shared : stateDir,
      );
    }
    expect(copiedNewOwner).toBe(false);
  });
});

describe("snapshot execution approvals", () => {
  const dirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
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
      const imported = await migrateLegacyExecApprovals({
        stateDir: source,
        env,
        detected: detectLegacyExecApprovals({ stateDir: source, doctorOnlyStateMigrations: true }),
        ...(interrupted
          ? {
              removeSource: () => {
                throw new Error("synthetic interrupted cleanup");
              },
            }
          : {}),
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

describe("snapshot row identities", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("preserves sparse row IDs and original bytes when preparing a migration rehearsal", async () => {
    const root = tempDirs.make("candidate-rowids-");
    const stateDir = path.join(root, "source");
    const targetStateDir = path.join(root, "rehearsal");
    const relative = path.join("agents", "main", "agent", "openclaw-agent.sqlite");
    const source = path.join(stateDir, relative);
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(targetStateDir);
    const db = openNodeSqliteDatabase(source);
    try {
      db.exec(`
        PRAGMA user_version = 3;
        CREATE TABLE evidence(value TEXT);
        INSERT INTO evidence(rowid, value) VALUES(71, 'preserved');
      `);
    } finally {
      db.close();
    }
    const original = await fs.readFile(source);
    const input = {
      stateDir,
      targetStateDir,
      candidateRoot: fileURLToPath(new URL("../../", import.meta.url)),
      config: {},
      env: {
        ...process.env,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
      },
    };
    const inventory = await readUpdateCandidateStateInventoryInProcess(input);
    await snapshotUpdateCandidateState({
      ...input,
      pluginPlanPath: path.join(targetStateDir, inventory.pluginPlan),
      databaseInventory: [...inventory.databases.keys()],
    });
    const snapshot = openNodeSqliteDatabase(path.join(targetStateDir, relative), {
      readOnly: true,
    });
    try {
      expect(snapshot.prepare("SELECT rowid, value FROM evidence").all()).toEqual([
        { rowid: 71, value: "preserved" },
      ]);
      expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(snapshot.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    } finally {
      snapshot.close();
    }
    expect(await fs.readFile(source)).toEqual(original);
  });
});
