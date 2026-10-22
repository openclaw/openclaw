import "./doctor-health.test-support.js";
import { execFile, fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs, { readFileSync as read } from "node:fs";
import path from "node:path";
import * as processIdentity from "@openclaw/proc-safe/identity";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
let { withUpdateCommandExecutor } = await import("../cli/update-cli/update-command-executor.js");
let { parseUpdateRecoveryBackupManifest } = await import("../commands/backup-verify-manifest.js");
let configFlow = await import("../commands/doctor-config-flow.js");
let { prepareDoctorDatabasePreflight } = await import("../commands/doctor-database-preflight.js");
let { beginDoctorMaintenance } = await import("../commands/doctor-maintenance.js");
let { hashConfigRaw } = await import("../config/io.read-helpers.js");
let { resolveStateDir } = await import("../config/paths.js");
let { resolveConfiguredAgentDatabaseTargets } = await import("../config/sessions/targets.js");
import type { OpenClawConfig } from "../config/types.openclaw.js";
let { resolveRuntimeProcessEntrypointUrl } = await import("../infra/runtime-process-url.js");
let { migrateLegacyMediaPersistence } =
  await import("../infra/state-migrations.media-persistence.js");
let { createLegacyStateMigrationStepReceipt } =
  await import("../infra/state-migrations.messages.js");
let { resolveUpdateCaptureRoot } = await import("../infra/update-capture-paths.js");
let { inspectUpdateRecoveryBackups } = await import("../infra/update-recovery-backup-status.js");
let { captureUpdateRecoveryBaseline } =
  await import("../infra/update-recovery-baseline-capture.js");
let { inspectUpdateRunDriver, readUpdateRunDriver } = await import("../infra/update-run-driver.js");
let { createUpdateRun, listUpdateRuns } = await import("../infra/update-run-ledger.js");
let { listAgentDatabaseAdmissionRefusals } = await import("../state/agent-database-admission.js");
let { closeOpenClawAgentDatabasesAsync, openOpenClawAgentDatabase } =
  await import("../state/openclaw-agent-db.js");
let databasePreflight = await import("../state/openclaw-database-preflight.js");
let { getOpenClawDatabaseMaintenanceScope } =
  await import("../state/openclaw-state-db-async-lifecycle.js");
let { closeOpenClawStateDatabaseAsync } = await import("../state/openclaw-state-db.js");
let { resolveInitialDoctorHealthContributions } =
  await import("./doctor-health-contributions-initial.js");
let { runDoctorHealthFlow } = await import("./doctor-health.js");

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFileSpy = vi.fn(actual.execFile);
  Object.defineProperty(
    execFileSpy,
    promisify.custom,
    Object.getOwnPropertyDescriptor(actual.execFile, promisify.custom)!,
  );
  return { ...actual, execFile: execFileSpy, fork: vi.fn(actual.fork), spawn: vi.fn(actual.spawn) };
});
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/proc-safe/identity")>();
  return { ...actual, readProcessAncestry: vi.fn(actual.readProcessAncestry) };
});

const { mocks, createDoctorRuntime, stubDoctorEnv } =
  await import("./doctor-health.test-support.js");
let { withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
const withDoctorState: typeof import("./doctor-health.test-support.js").withDoctorState = (
  run,
  env,
) => withOpenClawTestState({ scenario: "minimal", env }, run);

async function reloadStateDirFixtureGraph() {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  vi.resetModules();
  ({ withUpdateCommandExecutor } = await import("../cli/update-cli/update-command-executor.js"));
  ({ parseUpdateRecoveryBackupManifest } = await import("../commands/backup-verify-manifest.js"));
  configFlow = await import("../commands/doctor-config-flow.js");
  ({ prepareDoctorDatabasePreflight } = await import("../commands/doctor-database-preflight.js"));
  ({ beginDoctorMaintenance } = await import("../commands/doctor-maintenance.js"));
  ({ hashConfigRaw } = await import("../config/io.read-helpers.js"));
  ({ resolveStateDir } = await import("../config/paths.js"));
  ({ resolveConfiguredAgentDatabaseTargets } = await import("../config/sessions/targets.js"));
  ({ resolveRuntimeProcessEntrypointUrl } = await import("../infra/runtime-process-url.js"));
  ({ migrateLegacyMediaPersistence } =
    await import("../infra/state-migrations.media-persistence.js"));
  ({ createLegacyStateMigrationStepReceipt } =
    await import("../infra/state-migrations.messages.js"));
  ({ resolveUpdateCaptureRoot } = await import("../infra/update-capture-paths.js"));
  ({ inspectUpdateRecoveryBackups } = await import("../infra/update-recovery-backup-status.js"));
  ({ captureUpdateRecoveryBaseline } =
    await import("../infra/update-recovery-baseline-capture.js"));
  ({ inspectUpdateRunDriver, readUpdateRunDriver } = await import("../infra/update-run-driver.js"));
  ({ createUpdateRun, listUpdateRuns } = await import("../infra/update-run-ledger.js"));
  ({ listAgentDatabaseAdmissionRefusals } = await import("../state/agent-database-admission.js"));
  ({ closeOpenClawAgentDatabasesAsync, openOpenClawAgentDatabase } =
    await import("../state/openclaw-agent-db.js"));
  databasePreflight = await import("../state/openclaw-database-preflight.js");
  ({ getOpenClawDatabaseMaintenanceScope } =
    await import("../state/openclaw-state-db-async-lifecycle.js"));
  ({ closeOpenClawStateDatabaseAsync } = await import("../state/openclaw-state-db.js"));
  ({ resolveInitialDoctorHealthContributions } =
    await import("./doctor-health-contributions-initial.js"));
  ({ runDoctorHealthFlow } = await import("./doctor-health.js"));
  ({ withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js"));
}

const repairOptions = { repair: true, nonInteractive: true };
function required<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function installAdmissionContribution() {
  const noOp = async () => {};
  const admission = resolveInitialDoctorHealthContributions({
    runStructuredHealthRepairs: noOp,
    runGatewayConfigHealth: noOp,
    runAuthProfileMigration: noOp,
    runAuthProfileHealth: noOp,
    runGatewayAuthHealth: noOp,
    runLegacyStateHealth: noOp,
  }).find((contribution) => contribution.id === "doctor:agent-database-admission")!;
  mocks.runContributions.mockImplementation((ctx) => admission.run(ctx));
}

beforeEach(() => {
  vi.mocked(processIdentity.readProcessAncestry).mockReset();
  vi.mocked(execFile).mockReset();
  mocks.packageRoot.mockReturnValue(undefined);
  mocks.config.mockReturnValue({});
  mocks.runContributions.mockReset();
  mocks.runContributions.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function readCapturedConfig(directory: string, sourcePath: string) {
  const manifestPath = path.join(directory, "manifest.json");
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = parseUpdateRecoveryBackupManifest(manifestBytes.toString("utf8"));
  const entry = manifest.entries.find((item) => item.sourcePath === sourcePath);
  if (entry?.kind !== "file") {
    throw new Error(`Original configuration was not captured: ${sourcePath}`);
  }
  const payloadPath = path.join(directory, entry.archivePath);
  return { manifest, manifestPath, manifestBytes, payloadPath, bytes: read(payloadPath) };
}

it("preserves original config bytes before Doctor relocates and repairs legacy state", async () => {
  await reloadStateDirFixtureGraph();
  await withDoctorState(async (state) => {
    const legacyRoot = path.join(state.home, ".clawdbot");
    const legacyConfig = path.join(legacyRoot, "openclaw.json");
    const original = Buffer.from("// original operator formatting\n{ gateway: { port: 19101 } }\n");
    fs.writeFileSync(state.configPath, original);
    fs.renameSync(state.stateDir, legacyRoot);
    const expiredRunId = `doctor-${randomUUID()}`;
    const expiredCapture = path.join(resolveUpdateCaptureRoot(legacyRoot), expiredRunId);
    fs.mkdirSync(expiredCapture, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(expiredCapture, "manifest.json"),
      JSON.stringify({
        schemaVersion: 2,
        kind: "update-recovery",
        generation: { kind: "baseline" },
        databases: [],
        runId: expiredRunId,
        installRoot: process.cwd(),
        stateDir: legacyRoot,
        configPath: legacyConfig,
        configPaths: [legacyConfig],
        creator: { host: "fixture", pid: 1, startIdentity: "1" },
        drivers: [],
        createdAt: new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString(),
        roots: [legacyConfig],
        excludedRoots: [],
        protectedPaths: [legacyConfig],
        entries: [{ kind: "missing", sourcePath: legacyConfig, sqlite: false, directory: false }],
      }),
    );
    stubDoctorEnv({
      OPENCLAW_TEST_FAST: "0",
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_UPDATE_IN_PROGRESS: undefined,
      OPENCLAW_UPDATE_RUN_ID: undefined,
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    });
    mocks.packageRoot.mockReturnValue(process.cwd());
    const runtime = createDoctorRuntime();
    let captured: ReturnType<typeof readCapturedConfig> | undefined;
    const loadConfig = configFlow.loadAndMaybeMigrateDoctorConfig;
    const repair = vi
      .spyOn(configFlow, "loadAndMaybeMigrateDoctorConfig")
      .mockImplementation(async (params) => {
        const scope = required(getOpenClawDatabaseMaintenanceScope(), "Lost maintenance scope");
        expect(scope.ownsSchemaMaintenance).toBe(true);
        scope.assertOwnerCurrent();
        expect(fs.existsSync(legacyRoot)).toBe(false);
        expect(resolveStateDir(process.env)).toBe(state.stateDir);
        const store = resolveUpdateCaptureRoot(legacyRoot);
        const logs = runtime.log.mock.calls.flat().join("\n");
        const captures = fs.readdirSync(store).filter((name) => name.startsWith("doctor-"));
        expect(captures, logs).toHaveLength(1);
        captured = readCapturedConfig(path.join(store, captures[0]!), legacyConfig);
        expect(captured.bytes).toEqual(original);
        expect(captured.manifest.stateDir).toBe(legacyRoot);
        const result = await loadConfig(params);
        fs.writeFileSync(state.configPath, '{ "gateway": { "port": 19102 } }\n');
        return { ...result, path: state.configPath };
      });
    expect(resolveStateDir(process.env)).toBe(state.stateDir);
    await runDoctorHealthFlow(runtime, repairOptions);
    expect(repair).toHaveBeenCalledOnce();
    expect(fs.existsSync(expiredCapture)).toBe(false);
    expect(runtime.log).toHaveBeenCalledWith(
      `Retired superseded or expired standalone Doctor capture: ${expiredCapture}. Take a verified backup before an upgrade when you need a long-term recovery copy.`,
    );
    expect(fs.existsSync(legacyRoot)).toBe(false);
    expect(fs.readFileSync(state.configPath, "utf8")).toContain("19102");
    captured = required(captured, "Doctor did not reach the config repair boundary");
    expect(read(captured.manifestPath)).toEqual(captured.manifestBytes);
    expect(read(captured.payloadPath)).toEqual(original);
    expect(await inspectUpdateRecoveryBackups()).toEqual([
      expect.objectContaining({
        ref: expect.objectContaining({ manifestPath: captured.manifestPath }),
        runId: captured.manifest.runId,
        captureStatus: "pending",
        status: "manual",
        terminalOutcome: undefined,
      }),
    ]);
    expect(listUpdateRuns()).toEqual([]);
  });
});

it("reuses the admitted original capture and refuses changed evidence before Doctor repair", async () => {
  await withDoctorState(async (state) => {
    const original = '{ "gateway": { "port": 19111 } }\n';
    fs.writeFileSync(state.configPath, original);
    const driver = required(readUpdateRunDriver(), "Missing actual process identity");
    const run = createUpdateRun({ trigger: "cli", origin: { driver } }, { env: state.env });
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
    vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", "external");
    const installRoot = state.path("installation");
    fs.mkdirSync(installRoot);
    mocks.packageRoot.mockReturnValue(installRoot);
    const runtime = createDoctorRuntime();
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      const fence = await executor.enter(installRoot);
      const maintenance = required(
        await beginDoctorMaintenance({
          options: repairOptions,
          root: null,
          runtime,
          assertCurrent: fence.assertCurrent,
        }),
        "Missing actual maintenance custody",
      );
      let baseline: Awaited<ReturnType<typeof captureUpdateRecoveryBaseline>>;
      try {
        baseline = await maintenance.run(() => {
          const scope = required(getOpenClawDatabaseMaintenanceScope(), "Lost capture scope");
          return captureUpdateRecoveryBaseline({
            runId: run.runId,
            installRoot,
            env: process.env,
            drivers: [driver],
            signal: maintenance.signal,
            assertCurrent: () => {
              fence.assertCurrent();
              scope.assertOwnerCurrent();
            },
          });
        });
      } finally {
        await maintenance.release();
      }
      const captured = readCapturedConfig(baseline.ref.directory, state.configPath);
      expect(captured.bytes.toString("utf8")).toBe(original);
      const store = resolveUpdateCaptureRoot(state.stateDir);
      const originalEntries = fs.readdirSync(store).toSorted();
      const expectCaptureIntact = () => {
        expect(fs.readdirSync(store).toSorted()).toEqual(originalEntries);
        expect(read(captured.manifestPath)).toEqual(captured.manifestBytes);
        expect(read(captured.payloadPath).toString()).toBe(original);
      };
      const doctor = (current: string | Buffer, ref = baseline.ref) =>
        runDoctorHealthFlow(runtime, repairOptions, {
          inputHash: hashConfigRaw(current.toString()),
          assertCurrent: fence.assertCurrent,
          originalRecoveryCapture: { runId: run.runId, installRoot, ref },
        });
      const { readProcessAncestry: readAncestry } = await vi.importActual<
        typeof import("@openclaw/proc-safe/identity")
      >("@openclaw/proc-safe/identity");
      vi.mocked(processIdentity.readProcessAncestry).mockImplementation((pid, options) => {
        const observed = readAncestry(pid, { ...options, throughPid: process.pid });
        if (!observed || options?.throughPid === process.pid) {
          return observed;
        }
        // Only the higher supervisor's visibility is denied. The real driver,
        // executor, maintenance owner and retained capture stay authoritative.
        return { ...observed, complete: false, stoppedBy: "unreadable-parent" };
      });
      for (const [port, inheritedRunId] of [
        [19112, undefined],
        [19113, run.runId],
      ] as const) {
        vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", inheritedRunId);
        const current = `{ "gateway": { "port": ${port} } }\n`;
        fs.writeFileSync(state.configPath, current);
        await doctor(current);
        expect(fs.readFileSync(state.configPath, "utf8")).toBe(current);
        expectCaptureIntact();
      }
      for (const fault of ["missing", "digest", "terminal", "later-generation"] as const) {
        const current = read(state.configPath);
        const moved = `${baseline.ref.directory}-temporarily-missing`;
        const outcome = path.join(baseline.ref.directory, "outcome.json");
        const candidate = path.join(baseline.ref.directory, "candidate");
        const repair = vi.spyOn(configFlow, "loadAndMaybeMigrateDoctorConfig");
        if (fault === "missing") {
          fs.renameSync(baseline.ref.directory, moved);
        } else if (fault === "terminal") {
          fs.writeFileSync(
            outcome,
            JSON.stringify({ status: "committed", manifestSha256: baseline.ref.manifestSha256 }),
          );
        } else if (fault === "later-generation") {
          fs.mkdirSync(candidate);
        }
        try {
          await expect(
            doctor(
              current,
              fault === "digest"
                ? { ...baseline.ref, manifestSha256: "0".repeat(64) }
                : baseline.ref,
            ),
            fault,
          ).rejects.toThrow(/admitted original update capture/i);
          expect(repair, fault).not.toHaveBeenCalled();
          expect(mocks.runContributions, fault).toHaveBeenCalledTimes(2);
          expect(read(state.configPath), fault).toEqual(current);
        } finally {
          repair.mockRestore();
          if (fault === "missing") {
            fs.renameSync(moved, baseline.ref.directory);
          } else if (fault === "terminal") {
            fs.unlinkSync(outcome);
          } else if (fault === "later-generation") {
            fs.rmdirSync(candidate);
          }
        }
        expectCaptureIntact();
      }
      expect(mocks.runContributions).toHaveBeenCalledTimes(2);
      const retainedMessage = `Original update capture retained at ${baseline.ref.manifestPath}.`;
      expect(
        runtime.log.mock.calls.filter(([message]) => message === retainedMessage),
        runtime.log.mock.calls.flat().join("\n"),
      ).toHaveLength(2);

      const foreign = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      const closed = once(foreign, "close");
      const repair = vi.spyOn(configFlow, "loadAndMaybeMigrateDoctorConfig");
      const current = read(state.configPath);
      try {
        await once(foreign, "spawn");
        const foreignDriver = required(
          readUpdateRunDriver(foreign.pid),
          "Missing foreign identity",
        );
        expect(inspectUpdateRunDriver(foreignDriver)).toBe("alive");
        createUpdateRun({ trigger: "cli", origin: { driver: foreignDriver } }, { env: state.env });
        await expect(doctor(current)).rejects.toMatchObject({
          name: "DoctorMaintenanceRefusalError",
          refusal: { kind: "data-at-risk", reason: "unreadable-state" },
          cause: { message: expect.stringContaining(`driver PID ${foreignDriver.pid}`) },
        });
        expect(repair).not.toHaveBeenCalled();
        expect(mocks.runContributions).toHaveBeenCalledTimes(2);
        expect(read(state.configPath)).toEqual(current);
        expectCaptureIntact();
      } finally {
        foreign.stdin.end();
        await closed;
      }
    });
  });
});

it("shares one fleet preflight with Doctor admission and its health contribution", async () => {
  await withDoctorState(async (state) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, second: {}, third: {}, fourth: {} } },
    };
    await state.writeConfig(cfg);
    mocks.config.mockReturnValue(cfg);
    for (const agentId of Object.keys(cfg.agents!.entries!)) {
      openOpenClawAgentDatabase({ agentId, env: state.env });
    }
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    installAdmissionContribution();
    const inspect = vi.spyOn(databasePreflight, "preflightOpenClawDatabaseSchemas");
    vi.mocked(execFile).mockClear();
    vi.mocked(fork).mockClear();
    const runtime = createDoctorRuntime();
    await runDoctorHealthFlow(runtime, { nonInteractive: true });

    expect(mocks.runContributions).toHaveBeenCalledOnce();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(inspect.mock.calls.filter(([options]) => options.scope !== "state")).toHaveLength(1);
    const schemaEntry = String(resolveRuntimeProcessEntrypointUrl("agentSchemaInspection"));
    expect(
      vi.mocked(fork).mock.calls.filter(([entry]) => String(entry) === schemaEntry),
    ).toHaveLength(2);
    expect(
      vi
        .mocked(execFile)
        .mock.calls.filter(([, args]) => Array.isArray(args) && args.includes("schema-header")),
    ).toHaveLength(0);
  });
});

it.each(["hardlink", "relocated-copy"] as const)(
  "reconciles Doctor admission with physical quarantine across ancestor aliases: %s",
  async (kind) => {
    await withDoctorState(async (state) => {
      const originalRoot = state.stateDir;
      const relocatedRoot = state.path("relocated-state");
      const cleanerDirectory = state.statePath("agents", "cleaner");
      const configuredAlias = state.statePath("agent-alias");
      const sessionAlias = state.statePath("session-alias");
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {}, cleaner: { agentDir: path.join(configuredAlias, "agent") } },
        },
        session: {
          store: path.join(sessionAlias, "agents", "{agentId}", "sessions", "sessions.json"),
        },
      };
      const ownerPath = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      const physicalCopyPath = path.join(cleanerDirectory, "agent", "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(physicalCopyPath), { recursive: true });
      if (kind === "hardlink") {
        fs.linkSync(ownerPath, physicalCopyPath);
      } else {
        fs.copyFileSync(ownerPath, physicalCopyPath);
      }
      const originalBytes = fs.readFileSync(physicalCopyPath);
      fs.symlinkSync(cleanerDirectory, configuredAlias, "dir");
      fs.symlinkSync(originalRoot, sessionAlias, "dir");
      await state.writeConfig(cfg);
      mocks.config.mockReturnValue(cfg);
      installAdmissionContribution();
      const inspect = vi.spyOn(databasePreflight, "preflightOpenClawDatabaseSchemas");
      const loadConfig = configFlow.loadAndMaybeMigrateDoctorConfig;
      vi.spyOn(configFlow, "loadAndMaybeMigrateDoctorConfig").mockImplementation(async (params) => {
        const result = await loadConfig(params);
        if (kind === "relocated-copy") {
          await closeOpenClawAgentDatabasesAsync();
          await closeOpenClawStateDatabaseAsync();
          // The state-dir owner preserves the old locator after moving the whole root.
          fs.renameSync(originalRoot, relocatedRoot);
          fs.symlinkSync(relocatedRoot, originalRoot, "dir");
          process.env.OPENCLAW_STATE_DIR = relocatedRoot;
        }
        const repaired = await migrateLegacyMediaPersistence({
          env: process.env,
          configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(result.cfg, {
            env: process.env,
          }),
          preparedDiscovery: params.agentDatabaseMigrationDiscovery,
        });
        return {
          ...result,
          stateMigrationStepReceipts: [
            createLegacyStateMigrationStepReceipt(
              {
                id: "media-persistence",
                phase: "shared",
                source: [],
                target: [],
                requiredness: "conditional",
                reversibility: "checkpoint-required",
              },
              repaired,
            ),
          ],
        };
      });
      const prepared = await prepareDoctorDatabasePreflight();
      const refusedPath = path.join(configuredAlias, "agent", "openclaw-agent.sqlite");
      expect(prepared.agentRefusals).toEqual([
        expect.objectContaining({
          agentId: "cleaner",
          paths: [refusedPath],
          code: "agent-database-ownership-mismatch",
        }),
      ]);
      const runtime = createDoctorRuntime();
      await runDoctorHealthFlow(runtime, { nonInteractive: true }, undefined, prepared);
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(mocks.runContributions).toHaveBeenCalledOnce();
      const refusals = listAgentDatabaseAdmissionRefusals({ env: process.env });
      expect(refusals).toEqual(kind === "hardlink" ? prepared.agentRefusals : []);
      expect(mocks.runContributions.mock.calls[0]?.[0].agentDatabaseRefusals).toEqual(refusals);
      expect(inspect.mock.calls.filter(([options]) => options.scope !== "state")).toHaveLength(
        kind === "relocated-copy" ? 2 : 1,
      );
      const currentCopyPath =
        kind === "relocated-copy"
          ? path.join(relocatedRoot, "agents", "cleaner", "agent", "openclaw-agent.sqlite")
          : physicalCopyPath;
      const backups = fs
        .readdirSync(path.dirname(currentCopyPath))
        .filter((name) => name.startsWith("openclaw-agent.sqlite.corrupt-"));
      if (kind === "hardlink") {
        expect(backups).toEqual([]);
        expect(fs.statSync(currentCopyPath).ino).toBe(fs.statSync(ownerPath).ino);
      } else {
        expect(fs.existsSync(currentCopyPath)).toBe(false);
        expect(backups).toHaveLength(1);
        expect(fs.readFileSync(path.join(path.dirname(currentCopyPath), backups[0]!))).toEqual(
          originalBytes,
        );
      }
    });
  },
);
