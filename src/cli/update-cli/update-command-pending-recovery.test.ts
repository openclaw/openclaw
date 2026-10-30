import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import * as config from "../../config/config.js";
import * as launchd from "../../daemon/launchd.js";
import * as scheduledTasks from "../../daemon/schtasks-control.js";
import * as gatewayService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as databaseEngine from "../../infra/database-engine/config.js";
import { listDirectoryTreeStrictSync } from "../../infra/directory-walk.js";
import { resolvePackageActivationAnchor } from "../../infra/package-update-activation-journal.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import * as updateCheck from "../../infra/update-check.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import * as failureArtifacts from "../../infra/update-failure-report-artifact.js";
import * as updateGlobal from "../../infra/update-global.js";
import * as handoffCleanup from "../../infra/update-managed-service-handoff-cleanup.js";
import {
  POST_CORE_UPDATE_CHANNEL_ENV,
  POST_CORE_UPDATE_ENV,
} from "../../infra/update-post-core-context.js";
import { createRetainedCheckpointFixture } from "../../infra/update-retained-checkpoint.test-support.js";
import * as ledger from "../../infra/update-run-ledger.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import * as triage from "../../infra/update-triage.js";
import * as installedPlugins from "../../plugins/installed-plugin-index-records.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as stateOwnership from "../../state/openclaw-state-ownership-preflight.js";
import { expectNoCalls } from "../../test-utils/mock-call-assertions.js";
import { resolveProfileStateDir } from "../profile-utils.js";
import { registerSignalExitGate, waitForCliSignalExit } from "../signal-exit-barrier.js";
import * as updateShared from "./shared.js";
import type { UpdateCommandOptions } from "./shared.js";
import * as updateConfig from "./update-command-config.js";
import * as updateExecutor from "./update-command-executor.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import {
  createManagedServiceIdentityFixture,
  finishSuccessfulPackageSwitch,
  taskRecovery,
} from "./update-command-post-update.test-support.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import * as updateResume from "./update-command-resume.js";
import * as commandRun from "./update-command-run.js";
import { stubNodeRuntime } from "./update-command-runtime-recovery.test-support.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";
import { createWindowsTaskAutoStartRecovery } from "./update-command-windows-task.js";
import { updateCommand } from "./update-command.js";
import { updateRepairCommand } from "./update-repair-command.js";

const dirs = new Set<string>();
function quietRuntime() {
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
}
afterEach(() => cleanupTempDirs(dirs));
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const pendingRecovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" };
const candidateFailure = (runId: string, root?: string, reason = "candidate-failed") =>
  resultFixture(root, { status: "error", runId, reason, durationMs: 1 });
function expectPendingReport(fields: Record<string, unknown>) {
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({ ...fields, recovery: pendingRecovery }),
  );
}

function materialSnapshot(root: string) {
  return listDirectoryTreeStrictSync(root)
    .map((walkEntry) => walkEntry.relativePath)
    .map(String)
    .toSorted()
    .map((name) => {
      const filename = path.join(root, name);
      const stat = fs.lstatSync(filename);
      return {
        name,
        ino: stat.ino,
        mode: stat.mode,
        mtime: stat.mtimeMs,
        content: stat.isSymbolicLink()
          ? fs.readlinkSync(filename)
          : stat.isFile()
            ? createHash("sha256").update(fs.readFileSync(filename)).digest("hex")
            : null,
      };
    });
}

function pendingPackageInvocation(
  params: {
    serviceDrift?: boolean;
    alias?: boolean;
    existingRun?: boolean;
    profile?: string;
  } = {},
) {
  if (params.serviceDrift) {
    stubNodeRuntime();
  }
  const home = fs.realpathSync(makeTempDir(dirs, "pending-package-admission-"));
  const identity = createManagedServiceIdentityFixture(home);
  const state = resolveProfileStateDir(params.profile ?? "default", process.env, () => home);
  const source = path.join(home, "prefix", "lib", "node_modules", "openclaw");
  const serviceRoot = path.join(home, "service-prefix", "lib", "node_modules", "openclaw");
  const control = path.join(home, "control");
  for (const root of [source, serviceRoot]) {
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(root, "dist", "entry.js"), "// installed entrypoint\n");
  }
  fs.mkdirSync(state);
  fs.mkdirSync(control);
  const configPath = path.join(state, "openclaw.json");
  const contextPath = path.join(home, "triage.json");
  const metaPath = path.join(home, "sentinel.json");
  for (const [file, content] of Object.entries({
    [configPath]: "{}\n",
    [contextPath]: "retained triage\n",
    [metaPath]: JSON.stringify({ version: 1, meta: { triageContextPath: contextPath } }),
  })) {
    fs.writeFileSync(file, content);
  }
  for (const [key, value] of Object.entries({
    OPENCLAW_UPDATE_RUN_ID: undefined,
    [POST_CORE_UPDATE_ENV]: undefined,
    [POST_CORE_UPDATE_CHANNEL_ENV]: undefined,
    OPENCLAW_NIX_MODE: undefined,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_PROFILE: params.profile,
    OPENCLAW_CONFIG_READONLY: undefined,
    OPENCLAW_UPDATE_RUN_HANDOFF: "1",
    [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
  })) {
    vi.stubEnv(key, value);
  }
  if (params.existingRun) {
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", createUpdateRun({ trigger: "cli" }).runId);
    closeOpenClawStateDatabaseForTest();
  }
  let invocationRoot = source;
  if (params.alias) {
    invocationRoot = path.join(home, "invocation-root");
    fs.symlinkSync(source, invocationRoot, "dir");
  }
  vi.spyOn(updateShared, "resolveUpdateRoot").mockResolvedValue(invocationRoot);
  vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
  const manager = vi.spyOn(updateShared, "resolveGlobalManager").mockResolvedValue("npm");
  const service = createMockGatewayService({
    isLoaded: async () => true,
    readRuntime: async () => ({ status: "running", systemd: { managerUid: 2001 } }),
    readCommand: async () =>
      params.serviceDrift
        ? {
            programArguments: [
              process.execPath,
              path.join(serviceRoot, "dist", "entry.js"),
              "gateway",
            ],
          }
        : null,
  });
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  quietRuntime();
  const runTriage = vi.fn(async () => ({ status: "cancelled" as const }));
  const addPending = (root = params.serviceDrift ? serviceRoot : source) => {
    const anchor = resolvePackageActivationAnchor(root);
    fs.mkdirSync(anchor, { mode: 0o700 });
    // A crash during sealing is already pending, even before a complete journal exists.
    fs.writeFileSync(path.join(anchor, "candidate-evidence"), "retained package evidence\n", {
      mode: 0o600,
    });
    return anchor;
  };
  return {
    home,
    state,
    source,
    serviceRoot,
    restore() {
      vi.unstubAllEnvs();
      identity.restore();
    },
    addPending,
    writers: {
      stateWrite: vi.spyOn(stateOwnership, "assertOpenClawStateWriteAllowedAtPath"),
      configWrite: vi.spyOn(config, "assertConfigWriteAllowedInCurrentMode"),
      createRun: vi.spyOn(ledger, "createUpdateRun"),
      adoptRun: vi.spyOn(ledger, "adoptUpdateRun"),
      finishRun: vi.spyOn(ledger, "finishUpdateRun"),
      disableAutoStart: vi
        .spyOn(launchd, "disableCurrentOpenClawUpdateLaunchdJob")
        .mockResolvedValue(false),
      prepareTriage: vi.spyOn(triage, "prepareUpdateFailureTriage").mockResolvedValue(runTriage),
      writeTriage: vi.spyOn(failureArtifacts, "writeTriageUpdateFailure"),
      runTriage,
      cleanupHandoffs: vi.spyOn(handoffCleanup, "cleanupStaleManagedServiceUpdateHandoffs"),
      loadPlugins: vi.spyOn(installedPlugins, "loadInstalledPluginIndexInstallRecords"),
      resumePostCore: vi
        .spyOn(updateResume, "resumePostCoreUpdate")
        .mockRejectedValue(new Error("Untrusted continuation reached plugin convergence")),
      manager,
    },
  };
}

describe.skipIf(process.platform === "win32")("pending package activation admission", () => {
  it.each([
    { name: "canonical source behind an alias", alias: true },
    { name: "managed service in another prefix", serviceDrift: true, existingRun: true },
    { name: "caller with another profile", profile: "other", existingRun: true },
    {
      name: "malformed preview after service discovery",
      serviceDrift: true,
      malformedPreview: true,
    },
    {
      name: "malformed preview with existing service recovery",
      serviceDrift: true,
      malformedPreview: true,
      pendingBeforeDiscovery: true,
    },
    {
      name: "readable preview with existing service recovery",
      serviceDrift: true,
      readablePreview: true,
      pendingBeforeDiscovery: true,
    },
    {
      name: "readable preview after service discovery",
      serviceDrift: true,
      readablePreview: true,
    },
  ])("refuses $name before writable preparation or run admission", async (params) => {
    const f = pendingPackageInvocation(params);
    const dryRun = params.malformedPreview || params.readablePreview;
    const engineSelection = vi.spyOn(databaseEngine, "resolveDatabaseEngineSelection");
    try {
      f.writers.manager.mockRejectedValue(
        new Error("Package manager selection reached before retained recovery admission"),
      );
      let before: ReturnType<typeof materialSnapshot> | undefined;
      const retainPending = () => {
        f.addPending();
        before = materialSnapshot(f.home);
      };
      if (params.malformedPreview) {
        fs.mkdirSync(path.join(f.home, "tmp"));
        vi.stubEnv("TMPDIR", path.join(f.home, "tmp"));
        fs.writeFileSync(path.join(f.state, "openclaw.json"), "{");
      }
      if (dryRun && !params.pendingBeforeDiscovery) {
        const prepare = commandRun.prepareUpdateCommand;
        vi.spyOn(commandRun, "prepareUpdateCommand").mockImplementation(async (opts) => {
          const prepared = await prepare(opts);
          retainPending();
          return prepared;
        });
      } else {
        retainPending();
      }
      await expect(updateCommand({ json: true, yes: true, dryRun })).rejects.toMatchObject({
        code: 1,
      });
      expectPendingReport({
        status: "error",
        reason: "update-recovery-pending",
        ...(params.serviceDrift ? { root: f.serviceRoot } : {}),
      });
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringMatching(/recovery artifacts|publication recovery/i),
      );
      expectNoCalls(...Object.values(f.writers));
      if (params.malformedPreview) {
        expect(engineSelection).not.toHaveBeenCalled();
      } else if (params.readablePreview && !params.pendingBeforeDiscovery) {
        expect(engineSelection).toHaveBeenCalled();
      }
      expect(before).toBeDefined();
      expect(materialSnapshot(f.home)).toEqual(before);
      if (params.readablePreview) {
        expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
          expect.objectContaining({ reportPath: expect.any(String) }),
        );
      }
    } finally {
      f.restore();
    }
  });

  it.each([false, true])(
    "reports pending after lease acquisition (existing history and service drift=%s) without changing retained material",
    async (existingRun) => {
      const serviceDrift = existingRun;
      const f = pendingPackageInvocation({ existingRun, serviceDrift });
      const withExecutor = updateExecutor.withUpdateCommandExecutor;
      let anchor: string | undefined;
      let record: ReturnType<typeof ledger.getUpdateRun> | undefined;
      const retainedMaterial = () => ({
        source: materialSnapshot(f.source),
        service: materialSnapshot(f.serviceRoot),
        anchor: anchor ? materialSnapshot(anchor) : undefined,
        config: fs.readFileSync(path.join(f.state, "openclaw.json")),
        triage: fs.readFileSync(path.join(f.home, "triage.json")),
        sentinel: fs.readFileSync(path.join(f.home, "sentinel.json")),
      });
      let before: ReturnType<typeof retainedMaterial> | undefined;
      vi.spyOn(updateConfig, "readUpdateChannelConfig").mockResolvedValue({
        configSnapshot: await config.readConfigFileSnapshot({
          skipPluginValidation: true,
          observe: false,
        }),
        configReadFailure: undefined,
        legacyConfigPlan: undefined,
        storedChannel: null,
      });
      const metadata = vi
        .spyOn(updateGlobal, "createGlobalInstallEnv")
        .mockRejectedValue(
          new Error("package metadata must not run after pending lease admission"),
        );
      vi.spyOn(updateExecutor, "withUpdateCommandExecutor").mockImplementation(
        (runId, operation, options) =>
          withExecutor(
            runId,
            async (executor) =>
              operation({
                async enter(root, enterOptions) {
                  expect(root).toBe(f.source);
                  const fence = await executor.enter(root, enterOptions);
                  if (!anchor) {
                    anchor = f.addPending();
                    record = ledger.getUpdateRun(runId);
                    before = retainedMaterial();
                  }
                  return fence;
                },
              }),
            options,
          ),
      );
      try {
        await expect(updateCommand({ json: true, yes: true })).rejects.toMatchObject({ code: 1 });
        expect(anchor).toBeDefined();
        if (existingRun) {
          expect(record).toMatchObject({ status: "running" });
        } else {
          expect(record).toBeUndefined();
          expect(f.writers.createRun).not.toHaveBeenCalled();
          expect(fs.existsSync(path.join(f.state, "state", "openclaw.sqlite"))).toBe(false);
        }
        expectPendingReport({
          status: "error",
          reason: "update-recovery-pending",
          root: serviceDrift ? f.serviceRoot : f.source,
        });
        const { disableAutoStart, cleanupHandoffs, loadPlugins, writeTriage, runTriage } =
          f.writers;
        expectNoCalls(
          metadata,
          disableAutoStart,
          cleanupHandoffs,
          loadPlugins,
          writeTriage,
          runTriage,
        );
        expect(retainedMaterial()).toEqual(before);
        if (record) {
          expect(ledger.getUpdateRun(record.runId)).toMatchObject({ runId: record.runId });
        }
      } finally {
        f.restore();
      }
    },
  );
});

async function fixture() {
  const root = fs.realpathSync(makeTempDir(dirs, "pending-finalizer-"));
  const retained = createRetainedCheckpointFixture(root);
  const { env, options, file, run, runtime, record, displaced } = retained;
  retained.displace();
  const forbidden = (message: string) => () => {
    throw new Error(message);
  };
  const recovery = {
    options,
    fence: { assertCurrent: forbidden("prior owner released") },
    getRecord: () => record,
    onRecord: forbidden("retained record must not change"),
    assertReady: forbidden("no readiness authority"),
  };
  const opts: UpdateCommandOptions = { run, recovery };
  const windows = taskRecovery();
  const rollback = vi.fn(async () => {
    throw new Error("legacy rollback must not run");
  });
  const complete = vi.fn();
  const before = fs.readFileSync(displaced);
  return {
    root,
    env,
    file,
    displaced,
    run,
    opts,
    windows,
    rollback,
    complete,
    expectRetained() {
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readFileSync(displaced)).toEqual(before);
    },
    invoke: () =>
      finishSuccessfulPackageSwitch(
        { packageRoot: runtime.root, run },
        {
          root: runtime.root,
          opts,
          result: candidateFailure(run.runId, runtime.root),
          preManagedServiceStop: {
            inspected: true,
            runtimeInspected: true,
            running: false,
            stopped: true,
            serviceEnv: env,
            windowsTaskAutoStartRecovery: windows,
          },
          packageTransaction: { rollback, complete, backupRoot: path.join(root, "retained") },
        },
      ),
  };
}

describe("pending recovery finalizer", () => {
  it.each([
    { command: "finalize", invoke: updateFinalizeCommand },
    { command: "repair", invoke: updateRepairCommand },
  ])("refuses $command before recreating a displaced canonical database", async ({ invoke }) => {
    const f = await fixture();
    const configPath = path.join(f.root, "openclaw.json");
    const originalConfig = fs.readFileSync(configPath);
    const resolveRoot = vi
      .spyOn(updateShared, "resolveUpdateRoot")
      .mockRejectedValue(new Error("ordinary maintenance reached root discovery"));
    quietRuntime();
    await expect(
      withOwnedManagedUpdateEnv(
        { ...process.env, ...f.env, OPENCLAW_CONFIG_PATH: configPath },
        () => invoke({ json: true, yes: true, deferCompletionCache: true }),
      ),
    ).rejects.toThrow("full-state recovery is deferred");
    expect(resolveRoot).not.toHaveBeenCalled();
    f.expectRetained();
    expect(fs.readFileSync(configPath)).toEqual(originalConfig);
  });

  it("preserves a missing canonical database without live context", async () => {
    const f = await fixture();
    f.opts.recovery = undefined;
    const failure = await f.invoke().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      name: "UpdateCommandPendingRecoveryFailure",
      result: {
        reason: "candidate-failed",
        runId: f.run.runId,
        recovery: { serviceRestartSafe: false },
      },
    });
    f.expectRetained();
    expectNoCalls(f.rollback, f.complete, f.windows.restore, f.windows.complete);
  });
  it.each(["finalizer", "reported", "unexpected", "completed"] as const)(
    "keeps %s unwind away from autostart, history and managed triage",
    async (kind) => {
      const f = await fixture();
      const run = f.run;
      if (kind === "unexpected" || kind === "completed") {
        f.opts.recovery = undefined;
      }
      const context = path.join(f.root, "triage.json");
      const meta = path.join(f.root, "sentinel.json");
      fs.writeFileSync(context, "unchanged");
      fs.writeFileSync(meta, JSON.stringify({ version: 1, meta: { triageContextPath: context } }));
      const primary = candidateFailure(run.runId);
      const target = {
        root: f.root,
        env: {
          ...f.env,
          OPENCLAW_UPDATE_RUN_HANDOFF: "1",
          [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: meta,
        },
        failureResult: primary,
      };
      quietRuntime();
      const result = withUpdateFailureTriage({ ...f.opts, json: true }, target, () =>
        withUpdateCommandRecoveryUnwind(
          { ...f.opts, run },
          { triageTarget: target, windowsTaskAutoStartRecovery: f.windows },
          async () => {
            if (kind === "unexpected") {
              throw new Error("lost executor context");
            }
            if (kind === "reported") {
              throw new UpdateCommandFailure(primary);
            }
            if (kind === "finalizer") {
              await f.invoke();
            }
          },
        ),
      );
      await expect(result).rejects.toMatchObject({ code: 1 });
      expectPendingReport({
        reason: "candidate-failed",
        runId: run.runId,
      });
      f.expectRetained();
      expect(fs.readFileSync(context, "utf8")).toBe("unchanged");
      expect(f.windows.restore).not.toHaveBeenCalled();
      if (f.opts.recovery) {
        expect(f.windows.complete).not.toHaveBeenCalled();
      } else {
        expect(f.windows.complete).toHaveBeenCalledExactlyOnceWith(false, { preserveState: true });
      }
      expectNoCalls(f.rollback, f.complete);
    },
  );
});

it("settles interrupted Windows suspension without touching pending databases after mutation", async () => {
  const f = await fixture();
  const run = f.run;
  const before = materialSnapshot(f.root);
  const listeners = process.listeners("SIGINT");
  const previousExitCode = process.exitCode;
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const suspend = vi
    .spyOn(scheduledTasks, "suspendScheduledTaskAutoStartForUpdate")
    .mockResolvedValue(true);
  const resume = vi.spyOn(scheduledTasks, "resumeScheduledTaskAutoStartAfterUpdate");
  const recovery = createWindowsTaskAutoStartRecovery({ serviceEnv: f.env, updateRun: run });
  await recovery.suspended;
  recovery.beginMutation();
  const signal = process.listeners("SIGINT").find((listener) => !listeners.includes(listener));
  expect(signal).toBeDefined();
  const siblingFinished = createDeferredCore();
  const unregisterSibling = registerSignalExitGate(siblingFinished.promise);
  const retired = createDeferredCore();
  const removeListener = process.off.bind(process);
  // Bun removes native signal listeners without emitting EventEmitter.removeListener.
  // Observe the real removal effect, preserving its implementation and return value.
  const off = vi.spyOn(process, "off").mockImplementation((event, listener) => {
    const result = removeListener(event, listener);
    if (event === "SIGBREAK" && listener === signal) {
      retired.resolve();
    }
    return result;
  });
  const cause = new UpdateCommandRecoveryPendingError("Database rollback could not finish");
  try {
    signal!("SIGINT");
    await expect(
      withUpdateCommandRecoveryUnwind(
        { run },
        { triageTarget: { env: f.env }, windowsTaskAutoStartRecovery: recovery },
        async () => {
          throw cause;
        },
      ),
    ).rejects.toMatchObject({ name: "UpdateCommandPendingRecoveryFailure", cause });
    // Unwind releases its own gate without awaiting the still-pending sibling.
    expect(process.listeners("SIGINT")).toContain(signal);
    signal!("SIGINT");
    expect(process.listeners("SIGINT")).toContain(signal);
    siblingFinished.resolve();
    expect(await waitForCliSignalExit()).toBe(130);
    // Shared drain completion precedes this owner's status publication and retirement.
    // Observe removal of its last signal listener instead of flushing microtasks.
    await retired.promise;
    expect(process.listeners("SIGINT")).toEqual(listeners);
    expect(process.exitCode).toBe(130);
    expect(exit).not.toHaveBeenCalled();
    expect(suspend).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    expect(materialSnapshot(f.root)).toEqual(before);
  } finally {
    siblingFinished.resolve();
    unregisterSibling();
    await recovery.complete(false, { preserveState: true });
    await waitForCliSignalExit();
    await retired.promise;
    off.mockRestore();
    process.exitCode = previousExitCode;
  }
});

it.each([
  { confirmed: true, failed: true },
  { confirmed: false, failed: false },
  { confirmed: false, failed: true },
])(
  "preserves migrated state on unwind (confirmed=$confirmed, failed=$failed)",
  async ({ confirmed, failed }) => {
    const root = fs.realpathSync(makeTempDir(dirs, "migrated-unwind-"));
    const env = { HOME: root, OPENCLAW_STATE_DIR: root };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    closeOpenClawStateDatabaseForTest();
    const file = path.join(root, "state", "openclaw.sqlite");
    if (confirmed) {
      const db = new DatabaseSync(file);
      try {
        const row = db.prepare("PRAGMA user_version").get();
        db.exec(`PRAGMA user_version=${Number(row?.user_version) + 1}`);
      } finally {
        db.close();
      }
    }
    const before = fs.readFileSync(file);
    const windows = taskRecovery();
    const primary = candidateFailure(
      run.runId,
      undefined,
      confirmed ? "new-runtime-failed" : "candidate-failed",
    );
    const cause = confirmed
      ? new UpdateCommandFailure(primary)
      : new Error("candidate finalizer unavailable");
    const completion = withUpdateCommandRecoveryUnwind(
      { run },
      {
        ledgerHandoffOwned: true,
        ...(confirmed ? { ledgerHandoffCompleted: true } : {}),
        triageTarget: { env, ...(confirmed ? {} : { failureResult: primary }) },
        windowsTaskAutoStartRecovery: windows,
      },
      async () => {
        if (failed) {
          throw cause;
        }
      },
    );
    if (confirmed) {
      await expect(completion).rejects.toBe(cause);
      expect(windows.restore).toHaveBeenCalledOnce();
      expect(windows.complete).toHaveBeenCalledOnce();
    } else {
      await expect(completion).rejects.toMatchObject({
        name: "UpdateCommandPendingRecoveryFailure",
        result: { reason: "candidate-failed", recovery: { serviceRestartSafe: false } },
        ...(failed ? { cause } : {}),
      });
      expect(windows.restore).not.toHaveBeenCalled();
      expect(windows.complete).toHaveBeenCalledExactlyOnceWith(false);
    }
    expect(fs.readFileSync(file)).toEqual(before);
  },
);
