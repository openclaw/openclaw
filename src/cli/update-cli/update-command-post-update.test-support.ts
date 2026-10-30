import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { GATEWAY_SERVICE_SELECTOR_ENV_KEYS } from "../../daemon/constants.js";
import { GatewayServiceAuthorityError } from "../../daemon/service-update-authority.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service.js";
import * as updateCheck from "../../infra/update-check.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  hasDeferredUpdateModelRetirement,
  recordUpdateModelRetirement,
} from "../../infra/update-deferred-model-retirement.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { captureEnv } from "../../test-utils/env.js";
import { VERSION } from "../../version.js";
import { finishParams, updateResult } from "./update-command-maintenance-fixtures.test-support.js";
import { createPostCorePluginUpdateResult } from "./update-command-plugins-internals.js";
import { finishUpdate } from "./update-command-post-update.js";
import * as rollbackModule from "./update-command-rollback.js";
import * as sourceRuntime from "./update-command-runtime.js";
import { GatewayRestartHealthError } from "./update-command-service-command.js";
import type * as revalidation from "./update-command-service-revalidation.js";
import type * as service from "./update-command-service.js";
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
type FixtureMocks = {
  parkForeground: Mock;
  updatePlugins: Mock;
  completePluginUpdate: Mock;
  printResult: Mock;
  stopService: Mock<typeof service.maybeStopManagedServiceBeforeMutableUpdate>;
  restartService: Mock<typeof service.maybeRestartService>;
  readServiceState: Mock;
  revalidateService: Mock<typeof revalidation.revalidateManagedGatewayServiceAfterUpdate>;
};
type PostUpdateFixture<M> = { tempDirs: { make(prefix: string): string }; mocks: M };
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
  const input = finishParams({
    result: updateResult({
      mode: params.updateMode ?? "npm",
      root: packageRoot,
      ...(params.sealed && {
        before: { version: "2026.4.23" },
        after: {
          version: "2026.4.24",
          ...(params.updateMode === "git" ? { buildId: "new-build" } : {}),
        },
      }),
    }),
    root: packageRoot,
    previousInstallRoot: previousRoot,
    installKindChanged: !params.restartEnvironment,
    configSnapshot: validConfigSnapshot,
    storedChannel: null,
    channel: params.updateMode === "git" ? "dev" : "stable",
    downgradeRisk: true,
    shouldRestart: Boolean(params.restartEnvironment),
    opts: { json: params.json, run: params.run },
    controlPlaneUpdateSentinelMeta: {},
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

export const successfulPluginUpdate = createPostCorePluginUpdateResult({
  status: "ok",
  warnings: [],
});

export function registerForegroundFinalizationTests({
  tempDirs,
  mocks,
}: PostUpdateFixture<Omit<FixtureMocks, "readServiceState" | "revalidateService">>): void {
  it.each([
    ...(["noop", "runtime", "plugins", "park-failed"] as const).flatMap((outcome) =>
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
          const changed = outcome === "runtime" || outcome === "park-failed";
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
          coreAlreadyCurrent: outcome !== "retirement",
          shouldRestart: true,
          result: updateResult({
            status: outcome === "retirement" ? "ok" : "skipped",
            reason: outcome === "retirement" ? undefined : "already-current",
            mode: "git",
            root,
            before: { sha: "same", version: "1.0.0" },
            after: { sha: "same", version: "1.0.0" },
            durationMs: 0,
          }),
        },
        { candidateRuntime },
      );
      if (outcome === "park-failed") {
        await expect(finishing).rejects.toBeInstanceOf(Error);
        expect(events).toEqual(["park"]);
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
          {
            noop: [],
            runtime: ["park", "publish"],
            plugins: ["park", "doctor"],
            retirement: ["doctor"],
          }[outcome],
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
}: PostUpdateFixture<Pick<FixtureMocks, "readServiceState" | "restartService">>): void {
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
      const expectedEnvironment = {
        ...managedEnvironment,
        GEMINI_API_KEY: "allowed-runtime-credential",
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
        OPENAI_API_KEY: undefined,
        UNSET_PROVIDER_KEY: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
      };
      expect(
        Object.fromEntries(Object.keys(expectedEnvironment).map((key) => [key, installEnv?.[key]])),
      ).toEqual(expectedEnvironment);
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
  mocks: Omit<FixtureMocks, "parkForeground" | "updatePlugins" | "completePluginUpdate">,
) {
  it.each([
    { drift: false, restart: true, outcome: "ok", status: "skipped" },
    { drift: true, restart: true, outcome: "ok", status: "ok" },
    { drift: true, restart: false, outcome: "ok", status: "skipped" },
    { drift: true, restart: true, outcome: "reconciliation-pending", status: "skipped" },
    { drift: true, restart: true, outcome: "readiness-pending", status: "skipped" },
    { drift: false, restart: true, outcome: "absent", status: "skipped" },
  ] as const)(
    "reconciles an already-current service installation (drift=$drift, restart=$restart, outcome=$outcome)",
    async ({ drift, restart, outcome, status }) => {
      const identity = createManagedServiceIdentityFixture(makeHome());
      try {
        const absent = outcome === "absent";
        const absentMessage = "Gateway restart skipped: no Gateway service or listener is running.";
        const packageRoot = path.join(identity.home, "prefix-b");
        const serviceUpdateVerdict = absent
          ? { kind: "absent" as const }
          : {
              kind: "owned" as const,
              root: path.join(identity.home, drift ? "prefix-a" : "prefix-b"),
              fingerprint: "installed-command",
              refreshDefinition: true,
              requiresInstallRootRefresh: drift,
            };
        mocks.revalidateService.mockResolvedValue(serviceUpdateVerdict);
        mocks.readServiceState.mockResolvedValue(managedServiceState(process.env));
        const serviceObservation = {
          inspected: true,
          runtimeInspected: true,
          running: !absent,
          serviceEnv: process.env,
          serviceUpdateVerdict,
          ...(absent && {
            serviceMutationAllowed: false,
            serviceMutationSkipMessage: absentMessage,
          }),
        };
        mocks.restartService.mockImplementationOnce(async ({ result }) => {
          if (outcome === "absent") {
            throw new Error("An absent service must not restart");
          }
          expect(mocks.stopService).not.toHaveBeenCalled();
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
            result: updateResult({
              status: "skipped",
              reason: "already-current",
              root: packageRoot,
              before: { version: VERSION },
              after: { version: VERSION },
            }),
            preManagedServiceStop: { ...serviceObservation, stopped: false },
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
          expect(mocks.printResult.mock.lastCall?.[0].steps).toContainEqual(
            expect.objectContaining({
              advisory: expect.objectContaining({
                message: expect.stringContaining("Service reconciliation was skipped"),
              }),
            }),
          );
        }
        if (absent) {
          expect(mocks.printResult.mock.lastCall?.[0].steps).toEqual([]);
          expect(defaultRuntime.error).toHaveBeenCalledWith(absentMessage);
        }
      } finally {
        identity.restore();
      }
    },
  );
}

export function registerVerifiedActivationFailureTests({
  tempDirs,
  mocks,
}: PostUpdateFixture<Pick<FixtureMocks, "restartService" | "printResult">>) {
  it.each([
    "restart-health",
    "reported-failure",
    "authority",
    "unknown",
    "data-at-risk",
    "health-with-authority",
    "admission-unavailable",
  ] as const)(
    "classifies post-activation failures without granting authority (%s)",
    async (outcome) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("update-verified-target-") };
      const run = createUpdateRun({ trigger: "cli" }, { env });
      const rollback = vi.spyOn(rollbackModule, "rollbackFailedUpdate");
      mocks.restartService.mockImplementationOnce(async ({ onVerified }) => {
        onVerified?.(Date.now());
        if (outcome === "data-at-risk") {
          throw new DoctorMaintenanceRefusalError("Incomplete migration", {
            kind: "data-at-risk",
            reason: "incomplete-migration",
          });
        }
        if (outcome === "reported-failure") {
          return "restart-health-failed";
        }
        if (outcome === "authority") {
          throw new GatewayServiceAuthorityError(new Error("Service authority revoked"));
        }
        if (outcome === "admission-unavailable") {
          throw new DoctorMaintenanceRefusalError("Admission unavailable", {
            kind: "deferred",
            reason: "admission-unavailable",
          });
        }
        if (outcome === "health-with-authority") {
          throw new GatewayRestartHealthError("Health reporting failed", {
            cause: new GatewayServiceAuthorityError(new Error("Service authority revoked")),
          });
        }
        if (outcome === "unknown") {
          throw new Error("Unknown post-activation failure");
        }
        throw new GatewayRestartHealthError("post-activation receipt unavailable");
      });
      const finishing = finishSuccessfulPackageSwitch({
        run: { runId: run.runId, env },
        restartEnvironment: process.env,
      });
      if (outcome !== "restart-health" && outcome !== "reported-failure") {
        await expect(finishing).rejects.toMatchObject({
          result: {
            status: "error",
            ...(outcome === "data-at-risk"
              ? { recovery: { dataAtRisk: "incomplete-migration" } }
              : {}),
          },
        });
        expect(getUpdateRun(run.runId, { env })?.status).toBe("failed");
      } else {
        await expect(finishing).resolves.toBeUndefined();
        expect(rollback).not.toHaveBeenCalled();
        expect(getUpdateRun(run.runId, { env })?.status).toBe("succeeded");
        const result = mocks.printResult.mock.lastCall?.[0];
        expect(result.status).toBe("ok");
        expect(
          result.steps.find((step: { name: string }) => step.name === "post-update maintenance")
            ?.advisory,
        ).toMatchObject({
          kind: "recoverable-maintenance",
          message: expect.stringContaining(
            outcome === "restart-health"
              ? "post-activation receipt unavailable"
              : "restart-unhealthy",
          ),
        });
      }
    },
  );
}
