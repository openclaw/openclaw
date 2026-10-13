import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import * as serviceMembership from "../../daemon/service-process-membership.js";
import * as daemonService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as processAncestry from "../../infra/restart-stale-pids.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun, getUpdateRunAsync } from "../../infra/update-run-ledger.js";
import * as phaseWrites from "../../infra/update-run-write.async.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { VERSION } from "../../version.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import {
  createManagedServiceIdentityFixture,
  finishSuccessfulPackageSwitch,
  recordVerifiedGatewayRun,
  successfulPluginUpdate,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

export function registerCurrentCoreServiceReceiptTests({
  makeHome,
  mocks,
}: {
  makeHome: () => string;
  mocks: {
    readServiceState: Mock;
    stopService: Mock<typeof maybeStopManagedServiceBeforeMutableUpdate>;
    restartService: Mock<typeof import("./update-command-service.js").maybeRestartService>;
    updatePlugins: Mock;
    completePluginUpdate: Mock;
  };
}) {
  it
    .runIf(process.platform === "linux" || process.platform === "darwin")
    .each(["current", "requester-revoked"] as const)(
    "awaits current-core service history before Doctor with %s authority",
    async (outcome) => {
      const identity = createManagedServiceIdentityFixture(makeHome());
      const root = path.join(identity.home, "installed");
      const stateDir = path.join(identity.home, ".openclaw");
      const env = {
        HOME: identity.home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      };
      try {
        await fs.mkdir(root);
        await fs.mkdir(stateDir);
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw", version: VERSION, bin: "openclaw.mjs" }),
        );
        await fs.writeFile(path.join(root, "openclaw.mjs"), "// Inert service fixture.\n");
        await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        vi.stubEnv("OPENCLAW_CONFIG_PATH", env.OPENCLAW_CONFIG_PATH);
        vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", undefined);
        mockProcessPlatform("darwin");
        vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(identity.home);
        vi.spyOn(processAncestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
          pids: new Set([process.pid, process.ppid]),
          complete: true,
        });
        vi.spyOn(serviceMembership, "inspectServiceProcessMembershipSync").mockReturnValue(
          "outside",
        );
        let currentRequester = true;
        let running = true;
        const events: string[] = [];
        const stopEntered = createDeferredCore();
        const nativeStop = vi.fn(async () => {
          stopEntered.resolve();
          events.push("stop");
          running = false;
        });
        const service = createMockGatewayService({ stop: nativeStop });
        vi.spyOn(daemonService, "resolveGatewayService").mockReturnValue(service);
        mocks.readServiceState.mockImplementation(async () => ({
          installed: true,
          loadState: { status: "loaded" },
          running,
          runtime: {
            status: running ? "running" : "stopped",
            pid: running ? Math.max(process.pid, process.ppid) + 1 : undefined,
          },
          env,
          command: {
            programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
            environment: env,
          },
        }));
        mocks.stopService.mockImplementation(maybeStopManagedServiceBeforeMutableUpdate);
        const before = await maybeStopManagedServiceBeforeMutableUpdate({
          root,
          updateInstallKind: "package",
          shouldRestart: true,
          jsonMode: true,
          phase: "inspect",
        });
        expect(before.serviceUpdateVerdict?.kind).toBe("owned");
        const run: NonNullable<FinishUpdateParams["opts"]["run"]> = {
          runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
          env,
          requesterAuthority: { requester: {}, isCurrent: () => currentRequester },
        };
        const plugins = { ...successfulPluginUpdate, changed: true };
        mocks.updatePlugins.mockResolvedValue(plugins);
        mocks.completePluginUpdate.mockImplementation(
          async (params: { beforeDoctor?: () => Promise<void> }) => {
            await params.beforeDoctor?.();
            events.push("doctor");
            return { pluginUpdate: plugins, configSnapshot: validConfigSnapshot };
          },
        );
        mocks.restartService.mockImplementation(async (params) => {
          events.push("restart");
          running = true;
          recordVerifiedGatewayRun(run);
          params.onVerified?.(Date.now());
          return "ok";
        });
        const committed = createDeferredCore();
        const release = createDeferredCore();
        const write = phaseWrites.recordUpdateRunPhaseAsync;
        const phaseWriter = vi
          .spyOn(phaseWrites, "recordUpdateRunPhaseAsync")
          .mockImplementation(async (...args) => {
            const record = await write(...args);
            if (args[1] === "activating") {
              committed.resolve();
              await release.promise;
            }
            return record;
          });
        await withUpdateCommandExecutor(run.runId, async (executor) => {
          run.executorFence = await executor.enter(root);
          const finishing = finishSuccessfulPackageSwitch(
            { packageRoot: root, restartEnvironment: env, run, json: true },
            {
              coreAlreadyCurrent: true,
              mutationStarted: false,
              downgradeRisk: false,
              requestedChannel: null,
              storedChannel: "stable",
              shouldRestart: true,
              preManagedServiceStop: before,
              result: {
                status: "skipped",
                reason: "already-current",
                mode: "npm",
                root,
                before: { version: VERSION },
                after: { version: VERSION },
                steps: [],
                durationMs: 0,
              },
            },
          );
          try {
            const reached = await Promise.race([
              committed.promise.then(() => "receipt"),
              stopEntered.promise.then(() => "native-stop"),
              finishing.then(() => "finished"),
            ]);
            expect(reached).toBe("receipt");
            expect(events).toEqual([]);
            expect(nativeStop).not.toHaveBeenCalled();
            expect(await getUpdateRunAsync(run.runId, { env })).toMatchObject({
              phase: "activating",
              status: "running",
            });
            currentRequester = outcome === "current";
            release.resolve();
            if (currentRequester) {
              await finishing;
              expect(events).toEqual(["stop", "doctor", "restart"]);
              expect(nativeStop).toHaveBeenCalledOnce();
            } else {
              await expect(finishing).rejects.toThrow("requester-revoked");
              expect(events).toEqual([]);
              expect(nativeStop).not.toHaveBeenCalled();
              expect(await getUpdateRunAsync(run.runId, { env })).toMatchObject({
                phase: "activating",
                status: "running",
              });
            }
          } finally {
            release.resolve();
            await finishing.catch(() => undefined);
            phaseWriter.mockRestore();
          }
        });
      } finally {
        await closeStateDatabaseForTest();
        identity.restore();
      }
    },
  );
}
