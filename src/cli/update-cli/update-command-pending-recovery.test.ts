import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasUnjoinedWork, runManagedCommand } from "../../../scripts/lib/managed-child-process.mts";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.ts";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import * as triageUpdate from "../../commands/triage-update.js";
import * as config from "../../config/config.js";
import * as launchd from "../../daemon/launchd.js";
import * as gatewayService from "../../daemon/service.js";
import { resolvePackageActivationAnchor } from "../../infra/package-update-activation-journal.js";
import {
  swapStagedPackageInstall,
  type PackageUpdateTransaction,
} from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import * as updateCheck from "../../infra/update-check.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
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
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as stateOwnership from "../../state/openclaw-state-ownership.js";
import { resolveProfileStateDir } from "../profile-utils.js";
import * as updateShared from "./shared.js";
import type { UpdateCommandOptions } from "./shared.js";
import * as updateConfig from "./update-command-config.js";
import * as updateExecutor from "./update-command-executor.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import {
  POST_CORE_EXECUTOR_FD,
  POST_CORE_EXECUTOR_MAX_BYTES,
} from "./update-command-post-core-admission.js";
import {
  createManagedServiceIdentityFixture,
  finishSuccessfulPackageSwitch,
  taskRecovery,
} from "./update-command-post-update.test-support.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import * as updateResume from "./update-command-resume.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";
import { updateCommand } from "./update-command.js";

const dirs = new Set<string>();
afterEach(() => cleanupTempDirs(dirs));
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function materialSnapshot(root: string) {
  return fs
    .readdirSync(root, { recursive: true })
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

async function createCapablePackageSwapFixture(base: string) {
  const packages = await createPackageSwapFixture(base);
  const stageRoot = packages.params.stage.packageRoot;
  const worker = runtimeProcessEntrypoints.updateMigratedFinalize;
  const checkPath = path.join(stageRoot, "dist", worker.distWorkerPath);
  fs.mkdirSync(path.dirname(checkPath), { recursive: true });
  fs.writeFileSync(
    path.join(stageRoot, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2.0.0",
      type: "module",
    }),
  );
  fs.writeFileSync(
    checkPath,
    `await import(${JSON.stringify(resolveRuntimeWorkerUrl(worker).href)});\n`,
  );
  await writePackageDistInventory(stageRoot);
  return packages;
}

function pendingPackageInvocation(
  params: {
    redirected?: boolean;
    alias?: boolean;
    existingRun?: boolean;
    manager?: "npm" | "pnpm" | "bun";
    profile?: string;
    readOnlyConfig?: boolean;
  } = {},
) {
  const home = fs.realpathSync(makeTempDir(dirs, "pending-package-admission-"));
  const identity = createManagedServiceIdentityFixture(home);
  const state = resolveProfileStateDir(params.profile ?? "default", process.env, () => home);
  const source = path.join(home, "prefix", "lib", "node_modules", "openclaw");
  const target = path.join(home, "service-prefix", "lib", "node_modules", "openclaw");
  const control = path.join(home, "control");
  for (const root of [source, target]) {
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(root, "dist", "entry.js"), "// installed entrypoint\n");
  }
  fs.mkdirSync(state);
  fs.mkdirSync(control);
  const configPath = path.join(state, "openclaw.json");
  const contextPath = path.join(home, "triage.json");
  const metaPath = path.join(home, "sentinel.json");
  fs.writeFileSync(configPath, "{}\n");
  fs.writeFileSync(contextPath, "retained triage\n");
  fs.writeFileSync(metaPath, JSON.stringify({ meta: { triageContextPath: contextPath } }));
  for (const key of [
    "OPENCLAW_UPDATE_RUN_ID",
    POST_CORE_UPDATE_ENV,
    POST_CORE_UPDATE_CHANNEL_ENV,
    "OPENCLAW_NIX_MODE",
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_PROFILE", params.profile);
  vi.stubEnv("OPENCLAW_CONFIG_READONLY", params.readOnlyConfig ? "1" : undefined);
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
  vi.stubEnv(CONTROL_PLANE_UPDATE_SENTINEL_META_ENV, metaPath);
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
  const manager = vi
    .spyOn(updateShared, "resolveGlobalManager")
    .mockResolvedValue(params.manager ?? "npm");
  const service = gatewayService.resolveGatewayService();
  const readCommand = vi.fn(async () =>
    params.redirected
      ? { programArguments: [process.execPath, path.join(target, "dist", "entry.js"), "gateway"] }
      : null,
  );
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue({ ...service, readCommand });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  const stateWrite = vi.spyOn(stateOwnership, "assertOpenClawStateWriteAllowedAtPath");
  const configWrite = vi.spyOn(config, "assertConfigWriteAllowedInCurrentMode");
  const createRun = vi.spyOn(ledger, "createUpdateRun");
  const adoptRun = vi.spyOn(ledger, "adoptUpdateRun");
  const finishRun = vi.spyOn(ledger, "finishUpdateRun");
  const disableAutoStart = vi
    .spyOn(launchd, "disableCurrentOpenClawUpdateLaunchdJob")
    .mockResolvedValue(false);
  const runTriage = vi.fn(async () => ({ status: "cancelled" as const }));
  const prepareTriage = vi.spyOn(triage, "prepareUpdateFailureTriage").mockResolvedValue(runTriage);
  const writeTriage = vi.spyOn(triageUpdate, "writeTriageUpdateFailure");
  const cleanupHandoffs = vi.spyOn(handoffCleanup, "cleanupStaleManagedServiceUpdateHandoffs");
  const loadPlugins = vi.spyOn(installedPlugins, "loadInstalledPluginIndexInstallRecords");
  const resumePostCore = vi
    .spyOn(updateResume, "resumePostCoreUpdate")
    .mockRejectedValue(new Error("Untrusted continuation reached plugin convergence"));
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  const addPending = (root = params.redirected ? target : source) => {
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
    target,
    runId: process.env.OPENCLAW_UPDATE_RUN_ID,
    restore() {
      vi.unstubAllEnvs();
      identity.restore();
    },
    addPending,
    writers: {
      stateWrite,
      configWrite,
      createRun,
      adoptRun,
      finishRun,
      disableAutoStart,
      prepareTriage,
      writeTriage,
      runTriage,
      cleanupHandoffs,
      loadPlugins,
      resumePostCore,
      manager,
    },
  };
}

describe.skipIf(process.platform === "win32")("pending package activation admission", () => {
  it("preserves the ENV-only legacy continuation when no package recovery is pending", async () => {
    const f = pendingPackageInvocation({ existingRun: true });
    try {
      if (!f.runId) {
        throw new Error("Legacy parent's diagnostic run was not created");
      }
      const before = ledger.getUpdateRun(f.runId);
      vi.stubEnv(POST_CORE_UPDATE_ENV, "1");
      vi.stubEnv(POST_CORE_UPDATE_CHANNEL_ENV, "stable");
      f.writers.resumePostCore.mockResolvedValue(undefined);
      await expect(updateCommand({ json: true, yes: true })).resolves.toBeUndefined();
      expect(f.writers.resumePostCore).toHaveBeenCalledWith(
        expect.objectContaining({ root: f.source, channel: "stable" }),
      );
      expect(f.writers.createRun).not.toHaveBeenCalled();
      expect(f.writers.adoptRun).not.toHaveBeenCalled();
      expect(f.writers.finishRun).not.toHaveBeenCalled();
      expect(f.writers.disableAutoStart).not.toHaveBeenCalled();
      expect(f.writers.writeTriage).not.toHaveBeenCalled();
      expect(f.writers.runTriage).not.toHaveBeenCalled();
      expect(ledger.getUpdateRun(f.runId)).toEqual(before);
    } finally {
      f.restore();
    }
  });

  it.each(["valid", "missing", "malformed", "oversized", "stale"] as const)(
    "admits real preparation only through a bound post-core fd3 grant (%s)",
    async (inputKind) => {
      const f = pendingPackageInvocation({ existingRun: true });
      try {
        if (!f.runId) {
          throw new Error("Original diagnostic run was not created");
        }
        const runId = f.runId;
        const packages = await createCapablePackageSwapFixture(f.home);
        const driverName = "pending-admission.mjs";
        fs.writeFileSync(
          path.join(packages.params.stage.packageRoot, driverName),
          `
            import { withPostCoreUpdateExecutor } from ${JSON.stringify(new URL("./update-command-post-core-admission.ts", import.meta.url).href)};
            import { prepareUpdateCommand } from ${JSON.stringify(new URL("./update-command-run.ts", import.meta.url).href)};
            let preparationStarted = false;
            try {
              await withPostCoreUpdateExecutor({ json: true, yes: true }, async (admitted) => {
                if (!admitted.run?.executorFence) throw new Error("No delegated executor");
                admitted.run.executorFence.assertCurrent();
                preparationStarted = true;
                const prepared = await prepareUpdateCommand(admitted);
                admitted.run.executorFence.assertCurrent();
                process.stdout.write(JSON.stringify({
                  status: "prepared", preparationStarted,
                  root: prepared.discoveredRoot, runId: admitted.run.runId,
                  postCore: prepared.postCoreUpdateResume
                }) + "\\n");
              });
            } catch (error) {
              process.stdout.write(JSON.stringify({
                status: "refused", preparationStarted, name: error.name, message: error.message,
                reason: error.result?.reason, cause: error.cause?.message
              }) + "\\n");
              process.exitCode = 1;
            }
          `,
        );
        await updateExecutor.withUpdateCommandExecutor(runId, async (executor) => {
          const fence = await executor.enter(packages.packageRoot);
          const published = await swapStagedPackageInstall({
            ...packages.params,
            activation: { fence, nodeRunner: process.execPath, onPrepared: () => undefined },
            onTransaction: () => undefined,
          });
          expect(published.status, published.step.stderrTail ?? undefined).toBe("committed");
          expect(
            fs.existsSync(resolvePackageActivationAnchor(packages.packageRoot)),
            published.step.stderrTail ?? undefined,
          ).toBe(true);
          const authorityDatabase = path.relative(
            f.home,
            updateExecutor.captureUpdateCommandExecutorAuthority(fence).databasePath,
          );
          // Binding and releasing the real child changes only its authority store.
          const leaseMaterial = new Set([
            path.dirname(authorityDatabase),
            authorityDatabase,
            `${authorityDatabase}-wal`,
            `${authorityDatabase}-shm`,
            `${authorityDatabase}-journal`,
          ]);
          const material = () =>
            materialSnapshot(f.home).filter((entry) => !leaseMaterial.has(entry.name));
          const before = material();
          const observed = await updateExecutor.withUpdateCommandExecutorChild(
            fence,
            async (grant, bindChild) => {
              let stdout = "";
              let stderr = "";
              let inputError: Error | undefined;
              const code = await runManagedCommand({
                bin: process.execPath,
                args: [
                  "--import",
                  path.resolve("scripts/tsx.mjs"),
                  path.join(packages.packageRoot, driverName),
                ],
                cwd: f.home,
                env: {
                  ...process.env,
                  // The candidate runs outside the checkout but loads this source fixture.
                  TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
                  [POST_CORE_UPDATE_ENV]: "1",
                  [POST_CORE_UPDATE_CHANNEL_ENV]: "stable",
                },
                stdio: ["ignore", "pipe", "pipe", inputKind === "missing" ? "ignore" : "pipe"],
                timeoutMs: 20_000,
                requireProcessTreeExit: true,
                onReady(child) {
                  child.stdout?.on("data", (chunk: Buffer) => {
                    stdout += chunk.toString();
                  });
                  child.stderr?.on("data", (chunk: Buffer) => {
                    stderr += chunk.toString();
                  });
                  if (!child.pid) {
                    throw new Error("Post-core fixture did not spawn");
                  }
                  bindChild(child.pid);
                  if (inputKind !== "missing") {
                    const input = child.stdio[POST_CORE_EXECUTOR_FD];
                    if (!(input instanceof Writable)) {
                      throw new Error("Post-core fixture has no private input pipe");
                    }
                    input.on("error", (error: Error) => {
                      inputError = error;
                    });
                    const payload =
                      inputKind === "malformed"
                        ? "{"
                        : inputKind === "oversized"
                          ? Buffer.alloc(POST_CORE_EXECUTOR_MAX_BYTES + 1, 0x20)
                          : JSON.stringify(
                              inputKind === "stale"
                                ? {
                                    ...grant,
                                    parent: {
                                      ...grant.parent,
                                      updatedAt: grant.parent.updatedAt + 1,
                                    },
                                  }
                                : grant,
                            );
                    input.end(payload);
                  }
                },
              });
              if (inputKind !== "oversized") {
                expect(inputError).toBeUndefined();
              }
              return { code, stdout, stderr };
            },
          );
          expect(observed.code, observed.stderr + observed.stdout).toBe(
            inputKind === "valid" ? 0 : 1,
          );
          const result = JSON.parse(observed.stdout.trim());
          if (inputKind === "valid") {
            expect(result).toEqual({
              status: "prepared",
              preparationStarted: true,
              root: packages.packageRoot,
              runId,
              postCore: true,
            });
          } else {
            expect(result).toMatchObject({
              status: "refused",
              preparationStarted: false,
              name: "UpdateCommandPendingRecoveryFailure",
              reason: "update-recovery-pending",
              cause: expect.stringMatching(
                inputKind === "missing"
                  ? /pipe is missing|EBADF|ENOTTY|bad file descriptor/i
                  : inputKind === "malformed"
                    ? /JSON|Unexpected|property/i
                    : inputKind === "oversized"
                      ? /exceeds its bound/
                      : /does not match its parent/,
              ),
            });
          }
          expect(material()).toEqual(before);
          fence.assertCurrent();
        });
      } catch (error) {
        if (hasUnjoinedWork(error)) {
          // Unconfirmed child cleanup retains its package and authority artifacts.
          dirs.delete(f.home);
        }
        throw error;
      } finally {
        f.restore();
      }
    },
    45_000,
  );

  it.each([
    { name: "source with absent history" },
    { name: "canonical source behind an alias", alias: true },
    { name: "redirected service target", redirected: true, existingRun: true },
    {
      name: "pnpm caller with another profile",
      manager: "pnpm" as const,
      profile: "other",
      existingRun: true,
    },
    { name: "Bun caller with another profile", manager: "bun" as const, profile: "other" },
    { name: "externally managed config", readOnlyConfig: true, existingRun: true },
    { name: "forged post-core marker", postCore: "forged" as const },
    {
      name: "post-core marker with a released original executor",
      postCore: "released" as const,
      existingRun: true,
    },
  ])("refuses $name before writable preparation or run admission", async (params) => {
    const f = pendingPackageInvocation(params);
    try {
      const opts: UpdateCommandOptions = { json: true, yes: true };
      if (params.postCore) {
        vi.stubEnv(POST_CORE_UPDATE_ENV, "1");
        vi.stubEnv(POST_CORE_UPDATE_CHANNEL_ENV, "stable");
        if (params.postCore === "released") {
          if (!f.runId) {
            throw new Error("Original diagnostic run was not created");
          }
          const run: NonNullable<UpdateCommandOptions["run"]> = {
            runId: f.runId,
            env: { ...process.env },
          };
          await updateExecutor.withUpdateCommandExecutor(run.runId, async (executor) => {
            run.executorFence = await executor.enter(f.source);
          });
          opts.run = run;
        }
      }
      f.addPending();
      const before = materialSnapshot(f.home);
      await expect(updateCommand(opts)).rejects.toMatchObject({ code: 1 });
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          reason: "update-recovery-pending",
          ...(params.redirected ? { root: f.target } : {}),
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        }),
      );
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringMatching(/recovery artifacts|publication recovery/i),
      );
      for (const writer of Object.values(f.writers)) {
        expect(writer).not.toHaveBeenCalled();
      }
      expect(materialSnapshot(f.home)).toEqual(before);
    } finally {
      f.restore();
    }
  });

  it("reports pending after lease acquisition without housekeeping or changing retained material", async () => {
    const f = pendingPackageInvocation();
    const withExecutor = updateExecutor.withUpdateCommandExecutor;
    let anchor: string | undefined;
    let record: ReturnType<typeof ledger.getUpdateRun> | undefined;
    const retainedMaterial = () => ({
      source: materialSnapshot(f.source),
      target: materialSnapshot(f.target),
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
      legacyConfigPlan: undefined,
      storedChannel: null,
    });
    const metadata = vi
      .spyOn(updateGlobal, "createGlobalInstallEnv")
      .mockRejectedValue(new Error("package metadata must not run after pending lease admission"));
    vi.spyOn(updateExecutor, "withUpdateCommandExecutor").mockImplementation(
      (runId, operation, options) =>
        withExecutor(
          runId,
          async (executor) =>
            operation({
              async enter(root, enterOptions) {
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
      expect(record).toMatchObject({ status: "running" });
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          reason: "update-recovery-pending",
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        }),
      );
      expect(metadata).not.toHaveBeenCalled();
      expect(f.writers.disableAutoStart).not.toHaveBeenCalled();
      expect(f.writers.cleanupHandoffs).not.toHaveBeenCalled();
      expect(f.writers.loadPlugins).not.toHaveBeenCalled();
      expect(f.writers.writeTriage).not.toHaveBeenCalled();
      expect(f.writers.runTriage).not.toHaveBeenCalled();
      expect(retainedMaterial()).toEqual(before);
      if (!record) {
        throw new Error("The race did not reach an admitted update");
      }
      // Admission legitimately created this attempt before the anchor appeared.
      // Pending reporting may record its outcome, but must not erase the attempt.
      expect(ledger.getUpdateRun(record.runId)).toMatchObject({ runId: record.runId });
    } finally {
      f.restore();
    }
  });

  it.each([false, true])(
    "keeps retained package completion with its original live executor (released=%s)",
    async (released) => {
      const f = pendingPackageInvocation();
      try {
        const packages = await createCapablePackageSwapFixture(f.home);
        const run: NonNullable<UpdateCommandOptions["run"]> = {
          runId: createUpdateRun({ trigger: "cli" }).runId,
          env: { ...process.env },
        };
        const windows = taskRecovery();
        let transaction: PackageUpdateTransaction | undefined;
        const complete = () =>
          withUpdateCommandRecoveryUnwind(
            { run },
            { triageTarget: { env: run.env }, windowsTaskAutoStartRecovery: windows },
            async () => {
              if (!transaction || !run.executorFence) {
                throw new Error("Original package owner was not prepared");
              }
              await transaction.complete(
                { activationVerified: true },
                run.executorFence.assertCurrent,
              );
            },
          );
        await updateExecutor.withUpdateCommandExecutor(run.runId, async (executor) => {
          const fence = await executor.enter(packages.packageRoot);
          run.executorFence = fence;
          const result = await swapStagedPackageInstall({
            ...packages.params,
            activation: { fence, nodeRunner: process.execPath, onPrepared: () => undefined },
            onTransaction: (retained) => {
              transaction = retained;
            },
          });
          expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
          expect(transaction).toBeDefined();
          expect(fs.existsSync(resolvePackageActivationAnchor(packages.packageRoot))).toBe(true);
          if (!released) {
            await complete();
          }
        });
        if (released) {
          closeOpenClawStateDatabaseForTest();
          const before = materialSnapshot(f.home);
          await expect(complete()).rejects.toMatchObject({
            name: "UpdateCommandPendingRecoveryFailure",
            result: { recovery: { serviceRestartSafe: false } },
          });
          expect(materialSnapshot(f.home)).toEqual(before);
          expect(windows.restore).not.toHaveBeenCalled();
          expect(windows.complete).not.toHaveBeenCalled();
        } else {
          expect(fs.existsSync(resolvePackageActivationAnchor(packages.packageRoot))).toBe(false);
          expect(windows.restore).toHaveBeenCalledOnce();
          expect(windows.complete).toHaveBeenCalledOnce();
        }
        expect(
          JSON.parse(fs.readFileSync(path.join(packages.packageRoot, "package.json"), "utf8")),
        ).toMatchObject({ version: "2.0.0" });
        expect(fs.readFileSync(packages.launcher, "utf8")).toBe("candidate launcher\n");
        expect(f.writers.finishRun).not.toHaveBeenCalled();
        expect(f.writers.disableAutoStart).not.toHaveBeenCalled();
        expect(f.writers.writeTriage).not.toHaveBeenCalled();
        expect(f.writers.runTriage).not.toHaveBeenCalled();
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
  const recovery = {
    options,
    fence: {
      assertCurrent() {
        throw new Error("prior owner released");
      },
    },
    getRecord: () => record,
    onRecord() {
      throw new Error("retained record must not change");
    },
    assertReady() {
      throw new Error("no readiness authority");
    },
  };
  const opts: UpdateCommandOptions = { run, recovery };
  const windows = taskRecovery();
  const rollback = vi.fn(async () => {
    throw new Error("legacy rollback must not run");
  });
  const complete = vi.fn();
  return {
    root,
    env,
    file,
    displaced,
    opts,
    windows,
    rollback,
    complete,
    entries: () => 0,
    invoke: (previousInstallRoot = runtime.root) =>
      finishSuccessfulPackageSwitch(
        { packageRoot: runtime.root, run },
        {
          root: runtime.root,
          previousInstallRoot,
          opts,
          result: {
            status: "error",
            mode: "npm",
            root: runtime.root,
            runId: run.runId,
            reason: "candidate-failed",
            steps: [],
            durationMs: 1,
          },
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
  it("refuses standalone finalization before recreating a displaced canonical database", async () => {
    const f = await fixture();
    const before = fs.readFileSync(f.displaced);
    const configPath = path.join(f.root, "openclaw.json");
    const originalConfig = fs.readFileSync(configPath);
    const resolveRoot = vi
      .spyOn(updateShared, "resolveUpdateRoot")
      .mockRejectedValue(new Error("ordinary finalization reached root discovery"));
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    await expect(
      withOwnedManagedUpdateEnv(
        { ...process.env, ...f.env, OPENCLAW_CONFIG_PATH: configPath },
        () => updateFinalizeCommand({ json: true, yes: true, deferCompletionCache: true }),
      ),
    ).rejects.toThrow("full-state recovery is deferred");
    expect(resolveRoot).not.toHaveBeenCalled();
    expect(fs.existsSync(f.file)).toBe(false);
    expect(fs.readFileSync(f.displaced)).toEqual(before);
    expect(fs.readFileSync(configPath)).toEqual(originalConfig);
  });

  it.each([true, false])(
    "preserves a missing canonical database with live-context=%s",
    async (context) => {
      const f = await fixture();
      if (!context) {
        f.opts.recovery = undefined;
      }
      const before = fs.readFileSync(f.displaced);
      const failure = await f.invoke().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        name: "UpdateCommandPendingRecoveryFailure",
        result: {
          reason: "candidate-failed",
          runId: f.opts.run!.runId,
          recovery: { serviceRestartSafe: false },
        },
      });
      expect(f.entries()).toBe(0);
      expect(fs.existsSync(f.file)).toBe(false);
      expect(fs.readFileSync(f.displaced)).toEqual(before);
      expect(f.rollback).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.windows.restore).not.toHaveBeenCalled();
      expect(f.windows.complete).not.toHaveBeenCalled();
    },
  );
  it("refuses retained recovery without touching either the managed or caller root", async () => {
    const f = await fixture();
    const failure = await f.invoke(path.join(f.root, "caller-install")).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      name: "UpdateCommandPendingRecoveryFailure",
      result: { reason: "candidate-failed" },
    });
    expect(f.entries()).toBe(0);
    expect(fs.existsSync(f.file)).toBe(false);
    expect(f.rollback).not.toHaveBeenCalled();
    expect(f.windows.restore).not.toHaveBeenCalled();
  });

  it.each(["finalizer", "reported", "unexpected", "completed"] as const)(
    "keeps %s unwind away from autostart, history and managed triage",
    async (kind) => {
      const f = await fixture();
      const run = f.opts.run;
      if (!run) {
        throw new Error("fixture run absent");
      }
      if (kind === "unexpected" || kind === "completed") {
        f.opts.recovery = undefined;
      }
      const before = fs.readFileSync(f.displaced);
      const context = path.join(f.root, "triage.json");
      const meta = path.join(f.root, "sentinel.json");
      fs.writeFileSync(context, "unchanged");
      fs.writeFileSync(meta, JSON.stringify({ meta: { triageContextPath: context } }));
      const primary = {
        status: "error" as const,
        mode: "npm" as const,
        runId: run.runId,
        reason: "candidate-failed",
        steps: [],
        durationMs: 1,
      };
      const target = {
        root: f.root,
        env: {
          ...f.env,
          OPENCLAW_UPDATE_RUN_HANDOFF: "1",
          [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: meta,
        },
        failureResult: primary,
      };
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
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
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "candidate-failed",
          runId: run.runId,
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        }),
      );
      expect(fs.existsSync(f.file)).toBe(false);
      expect(fs.readFileSync(f.displaced)).toEqual(before);
      expect(fs.readFileSync(context, "utf8")).toBe("unchanged");
      expect(f.windows.restore).not.toHaveBeenCalled();
      expect(f.windows.complete).not.toHaveBeenCalled();
      expect(f.rollback).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
    },
  );
});

describe("migrated-runtime unwind", () => {
  it.each([false, true])(
    "preserves newer canonical state after handoff (failure=%s)",
    async (failed) => {
      const root = fs.realpathSync(makeTempDir(dirs, "migrated-unwind-"));
      const env = { HOME: root, OPENCLAW_STATE_DIR: root };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      closeOpenClawStateDatabaseForTest();
      const file = path.join(root, "state", "openclaw.sqlite");
      const db = new DatabaseSync(file);
      try {
        const row = db.prepare("PRAGMA user_version").get();
        db.exec(`PRAGMA user_version=${Number(row?.user_version) + 1}`);
      } finally {
        db.close();
      }
      const before = fs.readFileSync(file);
      const windows = taskRecovery();
      const failure = new UpdateCommandFailure({
        status: "error",
        mode: "npm",
        runId: run.runId,
        reason: "new-runtime-failed",
        steps: [],
        durationMs: 1,
      });
      const completion = withUpdateCommandRecoveryUnwind(
        { run },
        {
          ledgerHandoffOwned: true,
          ledgerHandoffCompleted: true,
          triageTarget: { env },
          windowsTaskAutoStartRecovery: windows,
        },
        async () => {
          if (failed) {
            throw failure;
          }
        },
      );
      if (failed) {
        await expect(completion).rejects.toBe(failure);
      } else {
        await expect(completion).resolves.toBeUndefined();
      }
      expect(windows.restore).toHaveBeenCalledOnce();
      expect(windows.complete).toHaveBeenCalledOnce();
      expect(fs.readFileSync(file)).toEqual(before);
    },
  );
});

it.each([false, true])(
  "leaves an unconfirmed migrated handoff pending (failure=%s)",
  async (failed) => {
    const root = fs.realpathSync(makeTempDir(dirs, "unconfirmed-handoff-"));
    const env = { HOME: root, OPENCLAW_STATE_DIR: root };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    closeOpenClawStateDatabaseForTest();
    const file = path.join(root, "state", "openclaw.sqlite");
    const before = fs.readFileSync(file);
    const windows = taskRecovery();
    const cause = new Error("candidate finalizer unavailable");
    const primary = {
      status: "error" as const,
      mode: "npm" as const,
      runId: run.runId,
      reason: "candidate-failed",
      steps: [],
      durationMs: 1,
    };
    await expect(
      withUpdateCommandRecoveryUnwind(
        { run },
        {
          ledgerHandoffOwned: true,
          triageTarget: { env, failureResult: primary },
          windowsTaskAutoStartRecovery: windows,
        },
        async () => {
          if (failed) {
            throw cause;
          }
        },
      ),
    ).rejects.toMatchObject({
      name: "UpdateCommandPendingRecoveryFailure",
      result: { reason: "candidate-failed", recovery: { serviceRestartSafe: false } },
      ...(failed ? { cause } : {}),
    });
    expect(windows.restore).not.toHaveBeenCalled();
    expect(windows.complete).toHaveBeenCalledExactlyOnceWith(false);
    expect(fs.readFileSync(file)).toEqual(before);
  },
);
