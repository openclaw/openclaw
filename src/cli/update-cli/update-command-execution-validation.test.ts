// Install the fixture mocks before loading the execution owner and its dependencies.
import "./update-command-execution.test-support.js";
import { once } from "node:events";
import fs from "node:fs/promises";
import http, { Agent, createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as configFile from "../../config/config.js";
import * as gatewayService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as gatewayCall from "../../gateway/call.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import * as portInspection from "../../infra/ports-inspect.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import {
  updateRunStepsFromResultStep,
  updateRunWarningMessages,
} from "../../infra/update-run-step.js";
import type { UpdateStepProgress } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import * as utils from "../../utils.js";
import * as restartProbe from "../daemon-cli/restart-health-probe.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  gatewayServiceCommandUsesRoot,
  inspectManagedGatewayServiceBeforeUpdate,
} from "./update-command-service-plan.js";

const { executionParams, inspectOrStopService, mocks, schemaContext, successfulUpdate } =
  await import("./update-command-execution.test-support.js");

describe("mutable update validation", () => {
  it.each(
    (["package", "git"] as const).flatMap((kind) =>
      [false, true].map((changed) => ({ kind, changed })),
    ),
  )(
    "checks admitted configuration before $kind rehearsal (changed=$changed)",
    async ({ kind, changed }) => {
      const { revalidateUpdateDatabaseContext } = await vi.importActual<
        typeof import("./update-command-managed-context.js")
      >("./update-command-managed-context.js");
      let current = schemaContext("default");
      mocks.captureSchemaContext.mockImplementation(async () => current);
      mocks.captureManagedPreflight.mockImplementation(async () => current);
      mocks.revalidateSchemaContext.mockImplementation(revalidateUpdateDatabaseContext);
      vi.spyOn(configFile, "readConfigFileSnapshot").mockImplementation(
        async () => current.configSnapshot,
      );
      const runStagedUpdate = async ({
        inspectGitTarget,
        validateCandidate,
      }: {
        inspectGitTarget?: (target: {
          schemaVersions: { state: number; agent: number };
        }) => Promise<void>;
        validateCandidate: (root: string) => Promise<unknown>;
      }) => {
        await inspectGitTarget?.({ schemaVersions: { state: 15, agent: 19 } });
        // Staging/building is outside the admission window and can take minutes.
        if (changed) {
          const config = { gateway: { port: 19002 } };
          current = {
            ...current,
            config,
            configSnapshot: {
              ...current.configSnapshot,
              raw: JSON.stringify(config),
              sourceConfig: config,
              config,
            },
          };
        }
        await validateCandidate("/candidate");
        return successfulUpdate;
      };
      mocks.runGitUpdate.mockImplementation(runStagedUpdate);
      mocks.runPackageUpdate.mockImplementation(runStagedUpdate);

      const execution = await executeMutableUpdate(executionParams(kind));

      expect(execution?.result.status).toBe(changed ? "error" : "ok");
      expect(mocks.validateCanary).toHaveBeenCalledTimes(changed ? 0 : 1);
      expect(mocks.serviceStopped).toBe(false);
      expect(execution?.mutationStarted).toBe(false);
      if (changed) {
        expect(execution?.result.reason).toBe("database-schema-preflight");
        expect(execution?.failure?.detail).toContain(
          "configuration changed during database admission",
        );
      }
    },
  );

  it.each(["package", "git"] as const)(
    "continues the %s update with the recorded readiness warning instead of inference repair",
    async (kind) => {
      const message =
        "Readiness probe http://127.0.0.1:18789/readyz failed: HTTP 502. Check the configured proxy.";
      const step: UpdateStepResult = {
        name: "candidate-gateway-startup",
        command: "gateway run",
        cwd: "/candidate",
        durationMs: 1,
        exitCode: null,
        advisory: { kind: "candidate-runtime-unavailable", message },
        failureFacts: [{ check: "readyz", code: "candidate-readiness-probe-failed", message }],
      };
      mocks.validateCanary.mockImplementation(async ({ onStep }) => {
        onStep(step);
        return {
          status: "ok",
          phase: "readiness",
          steps: [step],
          durationMs: 1,
          logTail: [message],
        };
      });
      const repair = await import("../../infra/update-repair-agent.js");
      const runRepair = vi.spyOn(repair, "runUpdateRepairLoop");
      const accepted = vi.fn();
      const runStagedUpdate = async ({
        validateCandidate,
      }: {
        validateCandidate?: (root: string) => Promise<unknown>;
      }) => {
        expect(validateCandidate).toBeTypeOf("function");
        await validateCandidate?.("/candidate");
        accepted();
        return successfulUpdate;
      };
      mocks.runPackageUpdate.mockImplementation(runStagedUpdate);
      mocks.runGitUpdate.mockImplementation(runStagedUpdate);
      const onStepComplete = vi.fn<NonNullable<UpdateStepProgress["onStepComplete"]>>();

      const execution = await executeMutableUpdate({
        ...executionParams(kind),
        progress: { onStepComplete },
      });

      expect(execution?.result.status).toBe("ok");
      expect(accepted).toHaveBeenCalledOnce();
      expect(runRepair).not.toHaveBeenCalled();
      expect(onStepComplete).toHaveBeenCalledWith(expect.objectContaining(step));
      const recorded = onStepComplete.mock.calls.flatMap(([completed]) =>
        updateRunStepsFromResultStep(completed),
      );
      expect(updateRunWarningMessages(recorded)).toEqual([message]);
      expect(recorded.every((entry) => entry.status === "completed")).toBe(true);
    },
  );

  it.each(
    (["package", "git"] as const).flatMap((kind) =>
      [undefined, 30_000, 600_000].map((timeoutMs) => ({ kind, timeoutMs })),
    ),
  )(
    "passes only the operator's $timeoutMs ms deadline to $kind candidate validation",
    async ({ kind, timeoutMs }) => {
      const runStagedUpdate = async ({
        validateCandidate,
      }: {
        validateCandidate?: (root: string) => Promise<unknown>;
      }) => {
        expect(validateCandidate).toBeTypeOf("function");
        await validateCandidate?.("/candidate");
        return successfulUpdate;
      };
      mocks.runPackageUpdate.mockImplementation(runStagedUpdate);
      mocks.runGitUpdate.mockImplementation(runStagedUpdate);

      const execution = await executeMutableUpdate({
        ...executionParams(kind),
        timeoutMs,
        updateStepTimeoutMs: timeoutMs ?? 30 * 60_000,
      });

      expect(execution?.result.status).toBe("ok");
      expect(mocks.validateCanary).toHaveBeenCalledOnce();
      expect(mocks.validateCanary.mock.calls[0]?.[0].root).toBe("/candidate");
      expect(mocks.validateCanary.mock.calls[0]?.[0].timeoutMs).toBe(timeoutMs);
    },
  );

  it.each([
    ["measured startup", undefined, true, undefined],
    ...(process.platform === "win32"
      ? []
      : [["different service installation", undefined, true, undefined] as const]),
    ["explicit allowance", 450_000, true, undefined],
    ["explicit deadline", 30_000, false, undefined],
    ["terminal version mismatch", undefined, false, "version"],
    ["replaced executor", undefined, false, "executor"],
  ] as const)(
    "preserves previous Gateway verification through slow readiness (%s)",
    async (allowance, timeoutMs, verified, failure) =>
      withTestDir({ prefix: "previous-gateway-readiness-" }, async (root) => {
        const installationDrift = allowance === "different service installation";
        const cliRoot = installationDrift ? path.join(root, "cli-install") : root;
        const serviceRoot = installationDrift ? path.join(root, "service-install") : root;
        if (installationDrift) {
          await fs.mkdir(cliRoot);
          await fs.mkdir(serviceRoot);
          await fs.writeFile(
            path.join(cliRoot, "package.json"),
            JSON.stringify({ name: "openclaw", version: "2.0.0" }),
          );
        }
        const readyAtMs = 400_000;
        let elapsedMs = 0;
        const epochMs = Date.now();
        vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
        vi.spyOn(Date, "now").mockImplementation(() => epochMs + elapsedMs);
        vi.spyOn(utils, "sleep").mockImplementation(async (delayMs) => {
          elapsedMs += delayMs;
        });
        let readyObservedAtMs: number | undefined;
        let stoppedAtMs: number | undefined;
        let replaceExecutor: (() => void) | undefined;
        // Keep the real loopback probe off Node's ambient proxy-aware global agent.
        const globalAgent = http.globalAgent;
        const agent = new Agent();
        const server = createServer((request, response) => {
          const ready = elapsedMs >= readyAtMs;
          if (request.url === "/readyz" && ready) {
            readyObservedAtMs = elapsedMs;
            replaceExecutor?.();
          }
          response.writeHead(request.url === "/readyz" && !ready ? 503 : 200).end();
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing synthetic Gateway listener");
        }
        try {
          http.globalAgent = agent;
          await fs.mkdir(path.join(serviceRoot, "dist"));
          await fs.writeFile(
            path.join(serviceRoot, "package.json"),
            JSON.stringify({
              name: "openclaw",
              version: "1.0.0",
              ...(installationDrift
                ? { openclaw: { schemaVersions: { state: 15, agent: 19 } } }
                : {}),
            }),
          );
          await fs.writeFile(path.join(serviceRoot, "dist", "index.js"), "");
          const context = schemaContext("default");
          const config = { gateway: { mode: "local" as const, port: address.port } };
          const configSnapshot = {
            ...context.configSnapshot,
            config,
            sourceConfig: config,
          };
          const managedEnv = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, ".openclaw") };
          vi.spyOn(os, "userInfo").mockReturnValue({
            uid: 1000,
            gid: 1000,
            username: "operator",
            homedir: root,
            shell: "/bin/sh",
          });
          mocks.captureManagedContext.mockResolvedValue({
            env: managedEnv,
            configSnapshot,
            pluginInstallRecords: {},
          });
          if (installationDrift) {
            mocks.captureSchemaContext.mockResolvedValue({
              ...context,
              env: managedEnv,
              readEnv: managedEnv,
              config,
              configSnapshot,
            });
          }
          vi.spyOn(configFile, "readConfigFileSnapshot").mockResolvedValue(configSnapshot);
          vi.spyOn(restartProbe, "resolveGatewayRestartProbeContext").mockResolvedValue({
            config,
            auth: {},
          });
          const service = createMockGatewayService({ isAbsent: vi.fn(async () => false) });
          vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
          vi.spyOn(service, "isAbsent").mockResolvedValue(false);
          vi.spyOn(service, "isLoaded").mockResolvedValue(true);
          vi.spyOn(service, "readRuntime").mockResolvedValue({
            status: "running",
            pid: 8000,
            systemd: { managerUid: 1000 },
          });
          vi.spyOn(service, "readCommand").mockResolvedValue({
            programArguments: [
              process.execPath,
              path.join(serviceRoot, "dist", "index.js"),
              "gateway",
            ],
          });
          expect(await gatewayServiceCommandUsesRoot({ root: serviceRoot, env: managedEnv })).toBe(
            true,
          );
          const originalVerdict = installationDrift
            ? await inspectManagedGatewayServiceBeforeUpdate({
                root: serviceRoot,
                state: await gatewayService.readGatewayServiceState(service, { env: managedEnv }),
              })
            : undefined;
          if (installationDrift) {
            expect(originalVerdict?.kind).toBe("owned");
          }
          vi.spyOn(portInspection, "inspectPortUsage").mockImplementation(async (port) => ({
            port,
            status: "busy",
            listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
            hints: [],
          }));
          vi.spyOn(gatewayCall, "callGateway").mockImplementation(
            gatewayHealthResponse({
              server: {
                version: failure === "version" ? "0.9.0" : "1.0.0",
                bootId: "previous-boot",
              },
            }),
          );
          mocks.nativeSupport.mockImplementation(async (candidate) => {
            candidate.executor.assertCurrent();
            expect(candidate.root).toBe(cliRoot);
            return true;
          });
          mocks.validateCanary.mockResolvedValue({
            status: "ok",
            phase: "readiness",
            durationMs: 70_000,
            logTail: [],
            steps: [
              {
                name: "candidate-gateway-startup",
                command: "gateway run",
                cwd: root,
                durationMs: 70_000,
                exitCode: 0,
              },
            ],
          });
          mocks.maybeStopService.mockImplementation(async ({ phase }) => {
            if (phase === "prepare") {
              stoppedAtMs = elapsedMs;
            }
            const stopped = inspectOrStopService(phase);
            if (stopped.serviceUpdateVerdict?.kind === "owned") {
              stopped.serviceUpdateVerdict = { ...stopped.serviceUpdateVerdict, root };
            }
            return originalVerdict?.kind === "owned"
              ? {
                  ...stopped,
                  servicePort: address.port,
                  serviceEnv: managedEnv,
                  serviceNodeRunner: process.execPath,
                  serviceUpdateVerdict: {
                    ...originalVerdict,
                    refreshDefinition: true,
                  },
                }
              : stopped;
          });
          mocks.runPackageUpdate.mockImplementation(
            async (
              params: Parameters<
                typeof import("./update-command-package.js").runPackageInstallUpdate
              >[0],
            ) => {
              await params.validateCandidate(cliRoot);
              await params.beforeActivate();
              return successfulUpdate;
            },
          );
          const params = {
            ...executionParams("package"),
            root: cliRoot,
            ...(installationDrift ? { managedServiceRoot: serviceRoot } : {}),
            timeoutMs,
            updateStepTimeoutMs: timeoutMs ?? 20 * 60_000,
          };
          if (failure === "executor") {
            replaceExecutor = () => {
              params.opts.run = { runId: "replacement-run", env: { OPENCLAW_STATE_DIR: root } };
            };
          }
          const coordinator = path.join(root, "coordinator");
          await fs.mkdir(coordinator);
          vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(coordinator);
          const runId = createUpdateRun({ trigger: "cli" }, { env: managedEnv }).runId;
          params.opts.run = { runId, env: managedEnv };
          const execution = await withUpdateCommandExecutor(runId, async (executor) => {
            mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
              admitExecutor(
                await executor.enter(cliRoot, {
                  serviceRoot: installationDrift ? serviceRoot : undefined,
                }),
              );
            });
            return executeMutableUpdate(params);
          });
          expect(mocks.nativeSupport).toHaveBeenCalledOnce();
          if (failure === "executor") {
            expect(execution?.result.status).toBe("error");
            expect(execution?.failure?.detail).toContain("lost its original executor");
            expect(stoppedAtMs).toBeUndefined();
            expect(execution?.previousVerified).toBe(false);
            return;
          }
          expect(execution?.result.status, JSON.stringify(mocks.runtimeError.mock.calls)).toBe(
            "ok",
          );
          expect(
            installationDrift
              ? execution?.originalManagedServiceRuntime?.verified
              : execution?.previousVerified,
            JSON.stringify({ readyObservedAtMs, stoppedAtMs }),
          ).toBe(verified);
          if (installationDrift) {
            expect(execution?.originalManagedServiceRuntime).toMatchObject({
              root: serviceRoot,
              version: "1.0.0",
              verified: true,
            });
          }
          if (verified) {
            expect(readyObservedAtMs).toBeGreaterThanOrEqual(readyAtMs);
            expect(stoppedAtMs).toBeGreaterThanOrEqual(readyObservedAtMs!);
          } else {
            expect(readyObservedAtMs).toBeUndefined();
            expect(stoppedAtMs).toBeLessThan(readyAtMs);
            if (failure === "version") {
              expect(stoppedAtMs).toBe(0);
            }
          }
        } finally {
          http.globalAgent = globalAgent;
          agent.destroy();
          server.closeAllConnections();
          const closed = once(server, "close");
          server.close();
          await closed;
        }
      }),
  );

  it("retains rejected Git canary findings in the terminal result", async () => {
    const fact = {
      check: "core/doctor/config-readable",
      code: "doctor-failed",
      message: "The configured state directory is not readable.",
      affectedKey: "stateDir",
    };
    mocks.validateCanary.mockResolvedValue({
      status: "error",
      reason: "doctor-failed",
      phase: "doctor",
      durationMs: 1,
      logTail: [fact.message],
      steps: [
        {
          name: "candidate-doctor",
          command: "openclaw doctor",
          cwd: "/candidate",
          durationMs: 1,
          exitCode: 1,
          stderrTail: fact.message,
          failureFacts: [fact],
        },
      ],
    });
    mocks.runGitUpdate.mockImplementation(
      async (params: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0]) => {
        if (!params.validateCandidate) {
          throw new Error("Expected the Git candidate validation callback");
        }
        await params.validateCandidate("/candidate");
        return { ...successfulUpdate, mode: "git" };
      },
    );

    const execution = await executeMutableUpdate(executionParams("git"));

    expect(execution?.result).toMatchObject({
      status: "error",
      reason: "doctor-failed",
      steps: [{ failureFacts: [fact] }],
    });
    expect(mocks.serviceStopped).toBe(false);
  });
});
