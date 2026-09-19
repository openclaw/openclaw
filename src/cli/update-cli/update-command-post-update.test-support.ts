import os from "node:os";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { GATEWAY_SERVICE_SELECTOR_ENV_KEYS } from "../../daemon/constants.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  hasDeferredUpdateModelRetirement,
  recordUpdateModelRetirement,
} from "../../infra/update-deferred-model-retirement.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { captureEnv } from "../../test-utils/env.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import { finishUpdate } from "./update-command-post-update.js";
import * as sourceRuntime from "./update-command-runtime.js";

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
  options?: Parameters<typeof finishUpdate>[1],
): Promise<void> {
  const packageRoot = params.packageRoot ?? "/tmp/openclaw-update";
  const previousRoot = params.previousRoot ?? packageRoot;
  await finishUpdate(
    {
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
    } as unknown as FinishUpdateParams,
    options,
  );
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
              name: "post-plugin doctor warning 1",
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
