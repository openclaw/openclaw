import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as membership from "../../daemon/service-process-membership.js";
import * as services from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as maintenance from "../../daemon/systemd-maintenance.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import * as ancestry from "../../infra/restart-stale-pids.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import * as drain from "./update-command-service-drain.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";
import * as verification from "./update-command-verification.js";

const { executionParams, mocks, successfulUpdate } =
  await import("./update-command-execution.test-support.js");
async function withServiceHome(run: (home: string) => Promise<void>): Promise<void> {
  const state = await createOpenClawTestState({
    label: "collected-update-service",
    env: {
      OPENCLAW_GATEWAY_PORT: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_SERVICE_MARKER: undefined,
      OPENCLAW_SERVICE_KIND: undefined,
      OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
    },
  });
  const tempRoot = vi
    .spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir")
    .mockReturnValue(state.root);
  try {
    // Use the same canonical account selectors as the maintained service fixture;
    // createOpenClawTestState's explicit relocation selectors are not service authority.
    await withEnvAsync(
      {
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
      },
      () => run(state.home),
    );
  } finally {
    await state.cleanup();
    tempRoot.mockRestore();
  }
}

export function registerServiceCollectionTests() {
  it.each(["unchanged", "definition changed", "authority revoked"] as const)(
    "revalidates a collected systemd user unit before publication: %s",
    (scenario) =>
      withServiceHome(async (home) => {
        expect(getFileLockProcessStartTime(process.pid)).not.toBeNull();
        mockProcessPlatform("linux");
        mockSystemAccountHome();
        vi.spyOn(membership, "inspectServiceProcessMembershipSync").mockReturnValue("outside");
        vi.spyOn(ancestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
          pids: new Set([process.pid, process.ppid, 1]),
          complete: true,
        });
        vi.spyOn(maintenance, "prepareSystemdGatewayMaintenance").mockResolvedValue(false);
        vi.spyOn(drain, "withGatewayMaintenanceDrain").mockImplementation(
          async ({ assertCurrent }, stop) => {
            assertCurrent();
            await stop();
            assertCurrent();
          },
        );
        const root = path.join(home, ".npm-global", "lib", "node_modules", "openclaw");
        await writePackageRoot(root, "1.0.0");
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, "{}");
        const command = {
          programArguments: [process.execPath, path.join(root, "dist", "index.js"), "gateway"],
          environment: { HOME: home },
          sourcePath: path.join(home, ".config", "systemd", "user", "openclaw-gateway.service"),
        };
        const originalCommand = structuredClone(command);
        const params = {
          ...executionParams("package"),
          root,
          invocationCwd: home,
          startedAt: Date.now(),
        };
        const runId = createUpdateRun({ trigger: "cli" }).runId;
        let requesterCurrent = true;
        params.opts.run = {
          runId,
          env: process.env,
          requesterAuthority: {
            requester: { channel: "telegram", senderId: "synthetic-owner" },
            isCurrent: () => requesterCurrent,
          },
        };
        let running = true;
        let metadataLoads = 0;
        let inspections = 0;
        const service = createMockGatewayService({
          label: "systemd",
          isLoaded: async () => true,
          readCommand: async (_env, options) => {
            if (inspections++ === 0) {
              expect(options?.loadForInspection).toBeUndefined();
            }
            return structuredClone(command);
          },
          readRuntime: async (_env, options) => {
            if (!running) {
              // systemd can collect the stopped unit between its command and runtime reads.
              const inspection = options?.loadForInspection;
              if (!inspection) {
                return { status: "unknown" };
              }
              if (scenario === "authority revoked") {
                requesterCurrent = false;
              }
              inspection.assertCurrent();
              expect(inspection.managerUid).toBe(2001);
              metadataLoads++;
            }
            return {
              status: running ? "running" : "stopped",
              ...(running ? { pid: Math.max(process.pid, process.ppid) + 1 } : {}),
              systemd: { managerUid: 2001, tasksCurrent: running ? 1 : 0 },
            };
          },
          stop: vi.fn(async () => {
            running = false;
            if (scenario === "definition changed") {
              command.programArguments.push("--port", "18790");
            }
          }),
        });
        vi.spyOn(services, "resolveGatewayService").mockReturnValue(service);
        const observations: Array<{
          phase?: string;
          kind?: string;
          inspected: boolean;
          running: boolean;
          stopped: boolean;
          skip?: string;
          block?: string;
        }> = [];
        mocks.maybeStopService.mockImplementation(
          async (options: Parameters<typeof maybeStopManagedServiceBeforeMutableUpdate>[0]) => {
            const observed = await maybeStopManagedServiceBeforeMutableUpdate(options);
            observations.push({
              phase: options.phase,
              kind: observed.serviceUpdateVerdict?.kind,
              inspected: observed.inspected,
              running: observed.running,
              stopped: observed.stopped,
              skip: observed.serviceMutationSkipMessage,
              block: observed.blockMessage,
            });
            return observed;
          },
        );
        vi.spyOn(verification, "verifyPreviousManagedGatewayForUpdate").mockImplementation(
          async (options) => {
            options.assertCurrent?.();
            options.onVerification(true);
          },
        );
        const published = vi.fn();
        mocks.runPackageUpdate.mockImplementation(async ({ beforeActivate }) => {
          await beforeActivate();
          published();
          return { ...successfulUpdate, root };
        });
        try {
          const execution = await withUpdateCommandExecutor(runId, async (executor) => {
            mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
              admitExecutor(await executor.enter(root));
            });
            return executeMutableUpdate(params);
          });
          expect(
            service.stop,
            JSON.stringify({ result: execution?.result, observations, inspections }),
          ).toHaveBeenCalledOnce();
          expect(execution?.preManagedServiceStop).toMatchObject({ stopped: true, running: true });
          if (scenario === "unchanged") {
            expect(execution?.result.status).toBe("ok");
            expect(execution?.mutationStarted).toBe(true);
            expect(metadataLoads).toBeGreaterThan(0);
            expect(published).toHaveBeenCalledOnce();
            expect(command).toEqual(originalCommand);
          } else {
            expect(execution?.mutationStarted).toBe(false);
            expect(execution?.result).toMatchObject({
              status: "error",
              reason:
                scenario === "authority revoked"
                  ? "requester-revoked"
                  : "managed-service-preflight",
            });
            expect(published).not.toHaveBeenCalled();
            if (scenario === "authority revoked") {
              expect(metadataLoads).toBe(0);
            } else {
              expect(execution?.result.steps.at(-1)?.failureFacts).toEqual([
                expect.objectContaining({ code: "service-definition-changed" }),
              ]);
            }
          }
          expect(service.install).not.toHaveBeenCalled();
          expect(service.start).not.toHaveBeenCalled();
          expect(service.restart).not.toHaveBeenCalled();
        } finally {
          await closeStateDatabaseForTest();
        }
      }),
  );
}
