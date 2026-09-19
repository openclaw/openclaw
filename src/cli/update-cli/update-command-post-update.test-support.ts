import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { GATEWAY_SERVICE_SELECTOR_ENV_KEYS } from "../../daemon/constants.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { captureEnv } from "../../test-utils/env.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import { finishUpdate } from "./update-command-post-update.js";

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
): Promise<void> {
  const packageRoot = params.packageRoot ?? "/tmp/openclaw-update";
  const previousRoot = params.previousRoot ?? packageRoot;
  await finishUpdate({
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
  } as unknown as FinishUpdateParams);
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
    { drift: false, restart: true, pending: false },
    { drift: true, restart: true, pending: false },
    { drift: true, restart: false, pending: false },
    { drift: true, restart: true, pending: true },
  ])(
    "reconciles an already-current service installation (drift=$drift, restart=$restart, pending=$pending)",
    async ({ drift, restart, pending }) => {
      const identity = createManagedServiceIdentityFixture(makeHome());
      try {
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
        mocks.restartService.mockImplementationOnce(async () => {
          expect(originalRunning).toBe(true);
          return pending ? "reconciliation-pending" : "ok";
        });
        await finishSuccessfulPackageSwitch(
          { packageRoot: path.join(identity.home, "prefix-b"), restartEnvironment: process.env },
          {
            coreAlreadyCurrent: true,
            shouldRestart: restart,
            mutationStarted: false,
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
        if (pending) {
          expect(mocks.printResult).toHaveBeenCalledWith(
            expect.objectContaining({ status: "ok" }),
            expect.anything(),
            expect.anything(),
          );
        }
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
