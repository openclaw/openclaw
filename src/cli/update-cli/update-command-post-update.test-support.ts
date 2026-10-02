import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { GATEWAY_SERVICE_SELECTOR_ENV_KEYS } from "../../daemon/constants.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import * as updateCheck from "../../infra/update-check.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  hasDeferredUpdateModelRetirement,
  recordUpdateModelRetirement,
} from "../../infra/update-deferred-model-retirement.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { captureEnv } from "../../test-utils/env.js";
import { VERSION } from "../../version.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import { finishUpdate } from "./update-command-post-update.js";
import * as sourceRuntime from "./update-command-runtime.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

vi.mock("./update-command-verification.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-verification.js")>()),
  verifyUpdatedGateway: vi.fn(async () => ({ ok: false, score: 0, summary: "stopped-free" })),
}));

export function createManagedServiceIdentityFixture(home: string) {
  const keys = [
    "HOME",
    "USERPROFILE",
    "OPENCLAW_HOME",
    "OPENCLAW_SUPERVISOR_MODE",
    ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
  ];
  const env = captureEnv(keys);
  // A private HOME does not change the OS account home checked by the real service guard.
  const userInfo = vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
  for (const key of keys) {
    delete process.env[key];
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    home,
    restore: () => {
      userInfo.mockRestore();
      env.restore();
    },
  };
}

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];
const resolveInstallKind = updateCheck.resolveUpdateInstallKind;

export function recordVerifiedGatewayRun(
  run: NonNullable<FinishUpdateParams["opts"]["run"]>,
): NonNullable<UpdateRunResult["verification"]> {
  const facts = {
    serviceRunning: true,
    versionMatch: true,
    settled: true,
    readyz: true,
    channelsReady: true,
    pluginErrors: [],
  };
  recordUpdateRunVerification(run.runId, facts, { env: run.env });
  return facts;
}

export function mockVerifiedGatewayRun(run: NonNullable<FinishUpdateParams["opts"]["run"]>): void {
  vi.mocked(verifyUpdatedGateway).mockImplementationOnce(async ({ result, expectedVersion }) => {
    result.verification = { ...recordVerifiedGatewayRun(run), runningVersion: expectedVersion };
    return { ok: true, score: 7, summary: "Restored Gateway is healthy." };
  });
}

export const validConfigSnapshot = {
  valid: true,
  parsed: {},
  config: {},
  runtimeConfig: {},
  sourceConfig: {},
  warnings: [],
  issues: [],
  legacyIssues: [],
};

export async function finishSuccessfulPackageSwitch(
  params: {
    previousRoot?: string;
    packageRoot?: string;
    restartEnvironment?: NodeJS.ProcessEnv;
    json?: boolean;
    sealed?: boolean;
    updateMode?: UpdateRunResult["mode"];
    stoppedForUpdate?: boolean;
    stoppedAtMs?: number;
    run?: FinishUpdateParams["opts"]["run"];
    windowsTaskAutoStartRecovery?: NonNullable<
      FinishUpdateParams["preManagedServiceStop"]
    >["windowsTaskAutoStartRecovery"];
  } = {
    restartEnvironment: process.env,
  },
  overrides: Partial<FinishUpdateParams> = {},
  options?: Parameters<typeof finishUpdate>[1],
): Promise<void> {
  const packageRoot = params.packageRoot ?? "/tmp/openclaw-update";
  const previousRoot = params.previousRoot ?? packageRoot;
  const input = {
    mutationStarted: true,
    result: {
      status: "ok",
      mode: params.updateMode ?? "npm",
      root: packageRoot,
      ...(params.sealed && {
        before: { version: "2026.4.23" },
        after: {
          version: "2026.4.24",
          ...(params.updateMode === "git" ? { buildId: "new-build" } : {}),
        },
      }),
      steps: [],
      durationMs: 1,
    },
    root: packageRoot,
    previousInstallRoot: previousRoot,
    installKindChanged: !params.restartEnvironment,
    configSnapshot: validConfigSnapshot,
    requestedChannel: null,
    storedChannel: null,
    channel: params.updateMode === "git" ? "dev" : "stable",
    downgradeRisk: true,
    shouldRestart: Boolean(params.restartEnvironment),
    opts: { json: params.json, run: params.run },
    controlPlaneUpdateSentinelMeta: {},
    preUpdatePluginInstallRecords: {},
    startedAt: Date.now(),
    updateStepTimeoutMs: 1_000,
    ...(params.restartEnvironment && {
      preManagedServiceStop: {
        stopped: params.stoppedForUpdate ?? true,
        stoppedAtMs: params.stoppedAtMs,
        windowsTaskAutoStartRecovery: params.windowsTaskAutoStartRecovery,
        ...(params.sealed && {
          serviceUpdateVerdict: {
            kind: "owned",
            root: previousRoot,
            refreshDefinition: false,
            fingerprint: "sealed",
          },
        }),
      },
      ownedManagedUpdateEnv: params.restartEnvironment,
    }),
    ...overrides,
  } as unknown as FinishUpdateParams;
  const installRoot = input.result.root ?? input.root;
  const packageInstall =
    input.result.mode === "npm" || input.result.mode === "pnpm" || input.result.mode === "bun";
  // This fixture declares its package context; other roots and Git mode keep real discovery.
  vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockImplementation(async (root, inspection) =>
    packageInstall && root === installRoot ? "package" : resolveInstallKind(root, inspection),
  );
  await finishUpdate(input, options);
}

export const programArguments = ["/usr/bin/node", "/tmp/openclaw-update/dist/index.js", "gateway"];

export function managedServiceState(
  env: NodeJS.ProcessEnv = {},
  command: Partial<GatewayServiceCommandConfig> = {},
  unloaded = false,
) {
  return {
    installed: true,
    loadState: { status: unloaded ? "not-loaded" : "loaded" },
    env,
    command: { programArguments: [...programArguments], ...command },
  };
}

export function taskRecovery(record: (phase: string) => void = () => {}) {
  return {
    suspended: Promise.resolve(true),
    beginMutation: vi.fn(() => record("mutation")),
    assertRecoveryCurrent: vi.fn(),
    restore: vi.fn(async () => record("restore")),
    handoff: vi.fn(),
    complete: vi.fn(async () => record("complete")),
    interrupted: () => false,
  };
}

export const successfulPluginUpdate: PostCorePluginUpdateResult = {
  status: "ok",
  changed: false,
  sync: {
    changed: false,
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
  warnings: [],
};

export function registerForegroundFinalizationTests({
  tempDirs,
  mocks,
}: {
  tempDirs: { make(prefix: string): string };
  mocks: {
    parkForeground: Mock;
    updatePlugins: Mock;
    completePluginUpdate: Mock;
    printResult: Mock;
    stopService: Mock;
    restartService: Mock;
  };
}): void {
  it.each([
    ...(["noop", "runtime", "plugins", "revoked", "park-failed"] as const).flatMap((outcome) =>
      [false, true].map((candidateRuntime) => ({ outcome, candidateRuntime })),
    ),
    { outcome: "retirement" as const, candidateRuntime: true },
  ])(
    "keeps foreground no-op and mutation outcomes accurate: $outcome (candidate=$candidateRuntime)",
    async ({ outcome, candidateRuntime }) => {
      const root = tempDirs.make("foreground-finalization-");
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
      vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", undefined);
      const run: NonNullable<FinishUpdateParams["opts"]["run"]> = {
        runId: createUpdateRun({ trigger: "api" }).runId,
        env: { ...process.env },
        completionOwner: "gateway-restart",
        ...(outcome === "retirement" ? { gatewayRestartRequired: true as const } : {}),
      };
      if (outcome === "retirement") {
        vi.stubEnv(UPDATE_RUN_ID_ENV, run.runId);
        recordUpdateModelRetirement("deferred");
      }
      const opts: FinishUpdateParams["opts"] = { run, json: true };
      const events: string[] = [];
      mocks.parkForeground.mockImplementation(async () => {
        events.push("park");
        if (outcome === "park-failed") {
          throw new Error("fixture parking failed");
        }
        run.gatewayRestartRequired = true;
      });
      vi.spyOn(sourceRuntime, "completeSourceUpdateRuntime").mockImplementation(
        async ({ beforePublication }) => {
          const changed =
            outcome === "runtime" || outcome === "revoked" || outcome === "park-failed";
          if (outcome === "revoked") {
            opts.run = { ...run };
          }
          if (changed) {
            await beforePublication?.();
            events.push("publish");
          }
          return { changed };
        },
      );
      const plugins = { ...successfulPluginUpdate, changed: outcome === "plugins" };
      mocks.updatePlugins.mockResolvedValue(plugins);
      mocks.completePluginUpdate.mockImplementation(async ({ beforeDoctor, onWarnings }) => {
        if (outcome !== "retirement" || hasDeferredUpdateModelRetirement()) {
          await beforeDoctor?.();
          events.push("doctor");
          if (outcome === "retirement") {
            recordUpdateModelRetirement("completed");
            onWarnings?.(["Deferred retirement repair warning"]);
          }
        }
        return { pluginUpdate: plugins, configSnapshot: validConfigSnapshot };
      });
      const finishing = finishSuccessfulPackageSwitch(
        { packageRoot: root, run, json: true },
        {
          opts,
          coreAlreadyCurrent: outcome !== "retirement",
          shouldRestart: true,
          result: {
            status: outcome === "retirement" ? "ok" : "skipped",
            reason: outcome === "retirement" ? undefined : "already-current",
            mode: "git",
            root,
            before: { sha: "same", version: "1.0.0" },
            after: { sha: "same", version: "1.0.0" },
            steps: [],
            durationMs: 0,
          },
        },
        { candidateRuntime },
      );
      if (outcome === "revoked" || outcome === "park-failed") {
        await expect(finishing).rejects.toBeInstanceOf(Error);
        expect(events).toEqual(outcome === "revoked" ? [] : ["park"]);
      } else {
        await finishing;
        if (outcome === "retirement") {
          expect(mocks.printResult.mock.lastCall?.[0].steps).toContainEqual(
            expect.objectContaining({
              name: "post-plugin-doctor-warning-1",
              advisory: {
                kind: "package-post-install-doctor",
                message: "Deferred retirement repair warning",
              },
            }),
          );
        }
        expect(events).toEqual(
          outcome === "noop"
            ? []
            : outcome === "runtime"
              ? ["park", "publish"]
              : outcome === "retirement"
                ? ["doctor"]
                : ["park", "doctor"],
        );
        expect(getUpdateRun(run.runId)).toMatchObject(
          outcome === "noop"
            ? { status: "skipped", phase: "finished", reason: "already-current" }
            : { status: "running", phase: "restarting" },
        );
        expect(mocks.printResult.mock.lastCall?.[0].status).toBe(
          outcome === "noop" ? "skipped" : "ok",
        );
      }
      expect(mocks.stopService).not.toHaveBeenCalled();
      expect(mocks.restartService.mock.calls.map(([params]) => params.shouldRestart)).toEqual(
        outcome === "retirement" ? [false] : [],
      );
    },
  );
}

export function registerManagedInstallEnvironmentTest({
  tempDirs,
  mocks,
}: {
  tempDirs: { make(prefix: string): string };
  mocks: {
    readServiceState: Mock;
    restartService: Mock<typeof import("./update-command-service.js").maybeRestartService>;
  };
}): void {
  it("removes operator overrides and process identity from the managed install environment", async () => {
    const packageRoot = tempDirs.make("openclaw-post-update-package-");
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: VERSION }),
    );
    const packageProgramArguments = [
      process.execPath,
      path.join(packageRoot, "dist", "index.js"),
      "gateway",
    ];
    const identity = createManagedServiceIdentityFixture(
      tempDirs.make("openclaw-post-update-service-home-"),
    );
    const managedEnvironment = {
      ANTHROPIC_API_KEY: "managed-provider",
      MANAGED_VALUE: "base",
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.work",
    };
    const effectiveEnvironment = {
      ...managedEnvironment,
      ANTHROPIC_API_KEY: "drop-in-provider",
      OPENAI_API_KEY: "operator-only-provider",
    };
    mocks.readServiceState.mockResolvedValueOnce(
      managedServiceState(effectiveEnvironment, {
        programArguments: packageProgramArguments,
        environment: effectiveEnvironment,
        managedDefinition: {
          programArguments: packageProgramArguments,
          environment: managedEnvironment,
        },
        managedOverrides: {
          environment: { keys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "UNSET_PROVIDER_KEY"] },
        },
      }),
    );
    vi.stubEnv("ANTHROPIC_API_KEY", effectiveEnvironment.ANTHROPIC_API_KEY);
    vi.stubEnv("OPENAI_API_KEY", effectiveEnvironment.OPENAI_API_KEY);
    vi.stubEnv("UNSET_PROVIDER_KEY", "removed-by-drop-in");
    vi.stubEnv("GEMINI_API_KEY", "allowed-runtime-credential");
    vi.stubEnv("OPENCLAW_PROFILE", "caller-only-profile");
    const callerStateDir = path.join(identity.home, ".openclaw-caller-only-profile");
    vi.stubEnv("OPENCLAW_STATE_DIR", callerStateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(callerStateDir, "openclaw.json"));
    try {
      const ownedUpdateEnvironment: NodeJS.ProcessEnv = { ...process.env, ...effectiveEnvironment };
      for (const key of ["OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]) {
        delete ownedUpdateEnvironment[key];
      }
      await finishSuccessfulPackageSwitch({
        packageRoot,
        restartEnvironment: ownedUpdateEnvironment,
      });

      const installEnv = mocks.restartService.mock.lastCall?.[0].serviceInstallEnv;
      expect(installEnv?.OPENAI_API_KEY).toBeUndefined();
      expect(installEnv?.UNSET_PROVIDER_KEY).toBeUndefined();
      expect(installEnv?.ANTHROPIC_API_KEY).toBe("managed-provider");
      expect(installEnv?.MANAGED_VALUE).toBe("base");
      expect(installEnv?.GEMINI_API_KEY).toBe("allowed-runtime-credential");
      expect(installEnv?.OPENCLAW_PROFILE).toBeUndefined();
      expect(installEnv?.OPENCLAW_STATE_DIR).toBeUndefined();
      expect(installEnv?.OPENCLAW_CONFIG_PATH).toBeUndefined();
      expect(installEnv?.OPENCLAW_SERVICE_MARKER).toBeUndefined();
      expect(installEnv?.OPENCLAW_SERVICE_KIND).toBeUndefined();
      expect(installEnv?.OPENCLAW_LAUNCHD_LABEL).toBe("ai.openclaw.work");
    } finally {
      vi.unstubAllEnvs();
      identity.restore();
    }
  });
}

export function expectFailureReport(
  printResult: Mock,
  reason: string,
  options: unknown = expect.any(Object),
) {
  expect(printResult).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error", reason }),
    options,
    expect.any(Object),
  );
  expect(defaultRuntime.exit).not.toHaveBeenCalled();
}

export function expectUpdateFailure(
  promise: Promise<unknown>,
  reason: string,
  details: object = {},
) {
  return expect(promise).rejects.toMatchObject({
    name: "UpdateCommandFailure",
    exitCode: 1,
    result: { status: "error", reason },
    ...details,
  });
}

export function registerServiceInstallationConvergenceTests(
  makeHome: () => string,
  mocks: {
    revalidateService: Mock<
      typeof import("./update-command-service.js").revalidateManagedGatewayServiceAfterUpdate
    >;
    readServiceState: Mock;
    stopService: Mock<
      typeof import("./update-command-service.js").maybeStopManagedServiceBeforeMutableUpdate
    >;
    restartService: Mock<typeof import("./update-command-service.js").maybeRestartService>;
    printResult: Mock;
  },
) {
  it.each([
    { drift: false, restart: true, outcome: "ok", status: "skipped" },
    { drift: true, restart: true, outcome: "ok", status: "ok" },
    { drift: true, restart: false, outcome: "ok", status: "skipped" },
    { drift: true, restart: true, outcome: "reconciliation-pending", status: "skipped" },
    { drift: true, restart: true, outcome: "readiness-pending", status: "skipped" },
  ] as const)(
    "reconciles an already-current service installation (drift=$drift, restart=$restart, outcome=$outcome)",
    async ({ drift, restart, outcome, status }) => {
      const identity = createManagedServiceIdentityFixture(makeHome());
      try {
        const packageRoot = path.join(identity.home, "prefix-b");
        const serviceUpdateVerdict = {
          kind: "owned" as const,
          root: path.join(identity.home, drift ? "prefix-a" : "prefix-b"),
          fingerprint: "installed-command",
          refreshDefinition: true,
          requiresInstallRootRefresh: drift,
        };
        mocks.revalidateService.mockResolvedValue(serviceUpdateVerdict);
        mocks.readServiceState.mockResolvedValue(managedServiceState(process.env));
        let originalRunning = true;
        mocks.stopService.mockImplementationOnce(async () => {
          originalRunning = false;
          return {
            stopped: true,
            inspected: true,
            runtimeInspected: true,
            running: true,
            serviceEnv: process.env,
            serviceUpdateVerdict,
          };
        });
        mocks.restartService.mockImplementationOnce(async ({ result }) => {
          expect(originalRunning).toBe(true);
          expect(result).toMatchObject({ status: "skipped", reason: "already-current" });
          expect(mocks.printResult).not.toHaveBeenCalled();
          if (outcome === "readiness-pending") {
            result.reason = "still-starting";
          }
          return outcome;
        });
        await finishSuccessfulPackageSwitch(
          { packageRoot, restartEnvironment: process.env },
          {
            coreAlreadyCurrent: true,
            shouldRestart: restart,
            mutationStarted: false,
            result: {
              status: "skipped",
              reason: "already-current",
              mode: "npm",
              root: packageRoot,
              before: { version: VERSION },
              after: { version: VERSION },
              steps: [],
              durationMs: 1,
            },
            preManagedServiceStop: {
              stopped: false,
              inspected: true,
              runtimeInspected: true,
              running: true,
              serviceEnv: process.env,
              serviceUpdateVerdict,
            },
          },
        );
        expect(mocks.restartService).toHaveBeenCalledTimes(drift && restart ? 1 : 0);
        expect(mocks.stopService).not.toHaveBeenCalled();
        expect(mocks.printResult).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ status }),
          expect.anything(),
          expect.anything(),
        );
        expect(mocks.printResult.mock.lastCall?.[0].reason).toBe(
          outcome === "readiness-pending"
            ? "still-starting"
            : status === "ok"
              ? undefined
              : "already-current",
        );
        if (drift && restart) {
          expect(mocks.restartService).toHaveBeenCalledWith(
            expect.objectContaining({ refreshServiceEnv: true, shouldRestart: true }),
          );
        } else if (drift) {
          expect(mocks.printResult).toHaveBeenCalledWith(
            expect.objectContaining({
              steps: expect.arrayContaining([
                expect.objectContaining({
                  advisory: expect.objectContaining({
                    message: expect.stringContaining("Service reconciliation was skipped"),
                  }),
                }),
              ]),
            }),
            expect.anything(),
            expect.anything(),
          );
        }
      } finally {
        identity.restore();
      }
    },
  );
}

export function registerUnverifiedDefinitionRecoveryTest(options: {
  fixture: () => FinishUpdateParams;
  makeHome: () => string;
  mocks: {
    rollback: Mock<typeof import("./update-command-rollback.js").rollbackFailedUpdate>;
    restart: Mock<typeof import("./update-command-service.js").maybeRestartService>;
    repair: Mock;
  };
}) {
  const { fixture, mocks, makeHome } = options;
  it("retains the previous package when native definition recovery is unverified", async () => {
    const params = fixture();
    const { transaction, packageRoot } = await createRetainedPackageSwap(makeHome());
    params.root = packageRoot;
    params.result.root = packageRoot;
    params.result.before = { version: "1.0.0" };
    params.result.after = { version: "2.0.0" };
    params.packageTransaction = transaction;
    params.rollbackBlockedReason = undefined;
    const complete = vi.spyOn(transaction, "complete");
    const restorePackage = vi.spyOn(transaction, "rollback");
    const actual = await vi.importActual<typeof import("./update-command-rollback.js")>(
      "./update-command-rollback.js",
    );
    mocks.rollback.mockImplementation(actual.rollbackFailedUpdate);
    mocks.restart.mockImplementationOnce(async ({ definitionRecovery, onVerificationFailure }) => {
      if (!definitionRecovery) {
        throw new Error("Finalization must retain native definition recovery state.");
      }
      definitionRecovery.unverified = true;
      onVerificationFailure?.("service-definition-rollback-unverified");
      return "failed";
    });

    await expect(finishUpdate(params)).rejects.toMatchObject({
      exitCode: 1,
      result: {
        status: "error",
        reason: "service-definition-rollback-unverified",
        root: packageRoot,
        rollbackOutcome: {
          status: "not-attempted",
          reason: "service-definition-rollback-unverified",
        },
      },
    });

    expect(mocks.rollback).toHaveBeenCalledOnce();
    expect(mocks.repair).not.toHaveBeenCalled();
    expect(restorePackage).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledExactlyOnceWith(
      { activationVerified: false },
      expect.any(Function),
    );
    await expect(
      fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
    ).resolves.toContain('"version":"1.0.0"');
    await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
      '"version":"2.0.0"',
    );
    expect(getUpdateRun(params.opts.run!.runId, { env: params.opts.run!.env })).toMatchObject({
      status: "failed",
      confirmedAtMs: null,
      reason: "service-definition-rollback-unverified",
    });
  });
}
