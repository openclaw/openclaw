import "./doctor-health.test-support.js";
import { execFile, fork, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { parseUpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import * as configFlow from "../commands/doctor-config-flow.js";
import { prepareDoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { createLegacyStateMigrationStepReceipt } from "../infra/state-migrations.messages.js";
import { resetAutoMigrateLegacyStateDirForTest } from "../infra/state-migrations.state-dir.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { inspectUpdateRecoveryBackups } from "../infra/update-recovery-backup-status.js";
import { captureUpdateRecoveryBaseline } from "../infra/update-recovery-baseline-capture.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { createUpdateRun, listUpdateRuns } from "../infra/update-run-ledger.js";
import { listAgentDatabaseAdmissionRefusals } from "../state/agent-database-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import * as databasePreflight from "../state/openclaw-database-preflight.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveInitialDoctorHealthContributions } from "./doctor-health-contributions-initial.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

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

const { mocks } = await import("./doctor-health.test-support.js");

beforeEach(() => {
  vi.mocked(execFile).mockReset();
  mocks.packageRoot.mockReturnValue(undefined);
  mocks.runContributions.mockReset();
});

afterEach(() => {
  resetAutoMigrateLegacyStateDirForTest();
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
  return {
    manifest,
    manifestPath,
    manifestBytes,
    payloadPath,
    bytes: fs.readFileSync(payloadPath),
  };
}

it("preserves original config bytes before Doctor relocates and repairs legacy state", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const legacyRoot = path.join(state.home, ".clawdbot");
    const legacyConfig = path.join(legacyRoot, "openclaw.json");
    const original = Buffer.from("// original operator formatting\n{ gateway: { port: 19101 } }\n");
    fs.writeFileSync(state.configPath, original);
    fs.renameSync(state.stateDir, legacyRoot);
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
    vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", "external");
    mocks.packageRoot.mockReturnValue(process.cwd());
    mocks.config.mockReturnValue({});
    mocks.runContributions.mockResolvedValue(undefined);
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    let captured: ReturnType<typeof readCapturedConfig> | undefined;
    const loadConfig = configFlow.loadAndMaybeMigrateDoctorConfig;
    const repair = vi
      .spyOn(configFlow, "loadAndMaybeMigrateDoctorConfig")
      .mockImplementation(async (params) => {
        const scope = getOpenClawDatabaseMaintenanceScope();
        if (!scope) {
          throw new Error("Doctor config repair lost its maintenance scope");
        }
        expect(scope.ownsSchemaMaintenance).toBe(true);
        scope.assertOwnerCurrent();
        expect(fs.lstatSync(legacyRoot).isSymbolicLink()).toBe(true);
        expect(fs.realpathSync(legacyRoot)).toBe(state.stateDir);
        expect(resolveStateDir(process.env)).toBe(state.stateDir);
        const store = resolveUpdateCaptureRoot(legacyRoot);
        expect(fs.existsSync(store), runtime.log.mock.calls.flat().join("\n")).toBe(true);
        const captures = fs.readdirSync(store).filter((name) => name.startsWith("doctor-"));
        expect(captures, runtime.log.mock.calls.flat().join("\n")).toHaveLength(1);
        expect(
          fs.existsSync(path.join(store, captures[0]!, "manifest.json")),
          runtime.log.mock.calls.flat().join("\n"),
        ).toBe(true);
        captured = readCapturedConfig(path.join(store, captures[0]!), legacyConfig);
        expect(captured.bytes).toEqual(original);
        expect(captured.manifest.stateDir).toBe(legacyRoot);
        const result = await loadConfig(params);
        fs.writeFileSync(state.configPath, '{ "gateway": { "port": 19102 } }\n');
        return { ...result, path: state.configPath };
      });
    try {
      expect(resolveStateDir(process.env)).toBe(legacyRoot);
      await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
      expect(repair).toHaveBeenCalledOnce();
      expect(fs.realpathSync(legacyRoot)).toBe(state.stateDir);
      expect(fs.readFileSync(state.configPath, "utf8")).toContain("19102");
      if (!captured) {
        throw new Error("Doctor did not reach the config repair boundary");
      }
      expect(fs.readFileSync(captured.manifestPath)).toEqual(captured.manifestBytes);
      expect(fs.readFileSync(captured.payloadPath)).toEqual(original);
      expect(await inspectUpdateRecoveryBackups({ installRoot: process.cwd() })).toEqual([
        expect.objectContaining({
          ref: expect.objectContaining({ manifestPath: captured.manifestPath }),
          runId: captured.manifest.runId,
          captureStatus: "pending",
          status: "manual",
          terminalOutcome: undefined,
        }),
      ]);
      expect(listUpdateRuns()).toEqual([]);
    } finally {
      repair.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

it("reuses the same original capture across Doctor continuations without recapturing current config", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const original = '{ "gateway": { "port": 19111 } }\n';
    fs.writeFileSync(state.configPath, original);
    const driver = readUpdateRunDriver();
    if (!driver) {
      throw new Error("The fixture requires its actual process identity");
    }
    const run = createUpdateRun({ trigger: "cli", origin: { driver } }, { env: state.env });
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
    vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", "external");
    try {
      const installRoot = state.path("installation");
      fs.mkdirSync(installRoot);
      mocks.packageRoot.mockReturnValue(installRoot);
      mocks.config.mockReturnValue({});
      mocks.runContributions.mockResolvedValue(undefined);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      await withUpdateCommandExecutor(run.runId, async (executor) => {
        const fence = await executor.enter(installRoot);
        const maintenance = await beginDoctorMaintenance({
          options: { repair: true, nonInteractive: true },
          root: null,
          runtime,
          assertCurrent: fence.assertCurrent,
        });
        if (!maintenance) {
          throw new Error("The fixture requires actual maintenance custody");
        }
        let baseline: Awaited<ReturnType<typeof captureUpdateRecoveryBaseline>>;
        try {
          baseline = await maintenance.run(() => {
            const scope = getOpenClawDatabaseMaintenanceScope();
            if (!scope) {
              throw new Error("Original update capture lost its maintenance scope");
            }
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
        for (const [port, inheritedRunId] of [
          [19112, undefined],
          [19113, run.runId],
        ] as const) {
          vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", inheritedRunId);
          const current = `{ "gateway": { "port": ${port} } }\n`;
          fs.writeFileSync(state.configPath, current);
          await runDoctorHealthFlow(
            runtime,
            { repair: true, nonInteractive: true },
            {
              inputHash: hashConfigRaw(current),
              assertCurrent: fence.assertCurrent,
              originalRecoveryCapture: { runId: run.runId, installRoot, ref: baseline.ref },
            },
          );
          expect(fs.readFileSync(state.configPath, "utf8")).toBe(current);
          expect(fs.readdirSync(store).toSorted()).toEqual(originalEntries);
          expect(fs.readFileSync(captured.manifestPath)).toEqual(captured.manifestBytes);
          expect(fs.readFileSync(captured.payloadPath, "utf8")).toBe(original);
        }
        expect(mocks.runContributions).toHaveBeenCalledTimes(2);
        expect(
          runtime.log.mock.calls.filter(
            ([message]) =>
              message === `Original update capture retained at ${baseline.ref.manifestPath}.`,
          ),
          runtime.log.mock.calls.flat().join("\n"),
        ).toHaveLength(2);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

it("shares one fleet preflight with Doctor admission and its health contribution", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { default: true }, second: {}, third: {}, fourth: {} } },
    };
    await state.writeConfig(cfg);
    mocks.config.mockReturnValue(cfg);
    for (const agentId of Object.keys(cfg.agents!.entries!)) {
      openOpenClawAgentDatabase({ agentId, env: state.env });
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
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
    const inspect = vi.spyOn(databasePreflight, "preflightOpenClawDatabaseSchemas");
    try {
      vi.mocked(execFile).mockClear();
      vi.mocked(fork).mockClear();
      vi.mocked(spawn).mockClear();
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
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
          .mocked(spawn)
          .mock.calls.filter(
            ([, args]) =>
              Array.isArray(args) &&
              args.includes(SQLITE_READONLY_CHILD_ARG) &&
              args.includes("session"),
          ),
      ).toHaveLength(2);
      expect(
        vi
          .mocked(execFile)
          .mock.calls.filter(([, args]) => Array.isArray(args) && args.includes("schema-header")),
      ).toHaveLength(0);
    } finally {
      inspect.mockRestore();
    }
  });
});

it.each(["copy", "hardlink", "relocated-copy"] as const)(
  "reconciles Doctor admission with physical quarantine across ancestor aliases: %s",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const originalRoot = state.stateDir;
      const relocatedRoot = state.path("relocated-state");
      const cleanerDirectory = state.statePath("agents", "cleaner");
      const configuredAlias = state.statePath("agent-alias");
      const sessionAlias = state.statePath("session-alias");
      const cfg: OpenClawConfig = {
        agents: {
          entries: {
            main: { default: true },
            cleaner: { agentDir: path.join(configuredAlias, "agent") },
          },
        },
        session: {
          store: path.join(sessionAlias, "agents", "{agentId}", "sessions", "sessions.json"),
        },
      };
      const ownerPath = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
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
      const inspect = vi.spyOn(databasePreflight, "preflightOpenClawDatabaseSchemas");
      const loadConfig = configFlow.loadAndMaybeMigrateDoctorConfig;
      const migration = vi
        .spyOn(configFlow, "loadAndMaybeMigrateDoctorConfig")
        .mockImplementation(async (params) => {
          const result = await loadConfig(params);
          if (kind === "relocated-copy") {
            closeOpenClawAgentDatabasesForTest();
            closeOpenClawStateDatabaseForTest();
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
      try {
        const prepared = await prepareDoctorDatabasePreflight();
        const refusedPath = path.join(configuredAlias, "agent", "openclaw-agent.sqlite");
        expect(prepared.agentRefusals).toEqual([
          expect.objectContaining({
            agentId: "cleaner",
            paths: [refusedPath],
            code: "agent-database-ownership-mismatch",
          }),
        ]);
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
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
      } finally {
        migration.mockRestore();
        inspect.mockRestore();
      }
    });
  },
);
