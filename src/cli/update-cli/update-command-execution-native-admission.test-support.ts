import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as bindings from "../../daemon/managed-gateway-bindings.js";
import { ServiceInspectionError } from "../../daemon/service-inspection-error.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import * as services from "../../daemon/service.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { inspectManagedGatewayServiceBeforeUpdate } from "./update-command-service-plan.js";

type Fixtures = Pick<
  typeof import("./update-command-execution.test-support.js"),
  "executionParams" | "mocks" | "successfulUpdate"
>;

export function registerNativeAdmissionTests({
  executionParams,
  mocks,
  successfulUpdate,
}: Fixtures) {
  it.each(["package", "staged", "git"] as const)(
    "refuses an unsupported native receiver before activation: %s",
    async (route) =>
      withTestDir({ prefix: "native-before-activation-" }, async (dir) => {
        const control = path.join(dir, "leases");
        await fs.mkdir(control);
        vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        const env = { OPENCLAW_STATE_DIR: dir };
        const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
        const params = executionParams(route === "git" ? "git" : "package");
        params.root = dir;
        params.updateStepTimeoutMs = 600_000;
        params.opts.run = { runId, env };
        if (route === "staged") {
          params.packageInstallSpec = path.join(dir, "candidate.tgz");
        }
        const events: string[] = [];
        mocks.nativeSupport.mockImplementation(async ({ executor }) => {
          executor.assertCurrent();
          events.push("native-admission");
          return false;
        });
        const candidate = async ({
          validateCandidate,
        }: {
          validateCandidate: (root: string) => Promise<unknown>;
        }) => {
          await validateCandidate(dir);
          // Models the package/Git publisher which follows successful validation.
          events.push("publish");
          return successfulUpdate;
        };
        mocks.runPackageUpdate.mockImplementation(candidate);
        mocks.runGitUpdate.mockImplementation(
          async (
            options: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0],
          ) => {
            if (!options.inspectGitTarget || !options.validateCandidate) {
              throw new Error("Missing actual Git admission callbacks");
            }
            await options.inspectGitTarget({ schemaVersions: { state: 15, agent: 19 } });
            return candidate({ validateCandidate: options.validateCandidate });
          },
        );
        const result = await withUpdateCommandExecutor(runId, async (executor) => {
          mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
            admitExecutor(await executor.enter(dir));
          });
          return executeMutableUpdate(params);
        });
        expect(result?.result).toMatchObject({
          status: "error",
          reason: "target-native-unsupported",
        });
        expect(events).toEqual(["native-admission"]);
        expect(mocks.nativeSupport.mock.calls[0]?.[0]).toMatchObject({
          timeoutMs: params.updateStepTimeoutMs,
        });
        expect(mocks.serviceStopped).toBe(false);
        expect(mocks.validateCanary).not.toHaveBeenCalled();
      }),
  );

  const consumerCases: Array<{
    name: string;
    shared: boolean;
    running: boolean;
    late: boolean;
    refused: boolean;
    route?: "git";
    consumer?: "selected" | "same-profile-other-service";
    unreadableFirst?: boolean;
  }> = [
    { name: "live shared root", shared: true, running: true, late: false, refused: true },
    { name: "stopped shared root", shared: true, running: false, late: false, refused: false },
    { name: "live disjoint root", shared: false, running: true, late: false, refused: false },
    {
      name: "sibling starts during staging",
      shared: true,
      running: true,
      late: true,
      refused: true,
    },
    {
      name: "Git shared publication",
      route: "git",
      shared: true,
      running: true,
      late: false,
      refused: true,
    },
    {
      name: "selected package no-restart",
      consumer: "selected",
      shared: true,
      running: true,
      late: false,
      refused: false,
    },
    {
      name: "same-profile other service",
      consumer: "same-profile-other-service",
      shared: true,
      running: true,
      late: false,
      refused: true,
    },
    {
      name: "unreadable unrelated definition",
      unreadableFirst: true,
      shared: false,
      running: true,
      late: false,
      refused: false,
    },
    {
      name: "live sibling after unreadable definition",
      unreadableFirst: true,
      shared: true,
      running: true,
      late: false,
      refused: true,
    },
  ];
  it.each(consumerCases)(
    "protects managed consumers before publication: $name",
    async (scenario) => {
      if (process.platform === "darwin") {
        // Model the Linux service reader, while retaining the real host self
        // identity used by the executor's POSIX lease and SQLite lifecycle.
        expect(getFileLockProcessStartTime(process.pid)).not.toBeNull();
        mockProcessPlatform("linux");
      }
      await withTestDir({ prefix: "shared-install-publication-" }, async (dir) => {
        const root = path.join(dir, "installed");
        const otherRoot = scenario.shared ? root : path.join(dir, "other-install");
        const candidate = path.join(dir, "candidate");
        for (const location of new Set([root, otherRoot, candidate])) {
          await fs.mkdir(path.join(location, "dist"), { recursive: true });
          await fs.writeFile(
            path.join(location, "package.json"),
            JSON.stringify({
              name: "openclaw",
              version: location === candidate ? "1.0.1" : "1.0.0",
            }),
          );
          await fs.writeFile(path.join(location, "dist", "entry.js"), "original runtime");
        }
        const artifact = path.join(root, "dist", "entry.js");
        const control = path.join(dir, "leases");
        await fs.mkdir(control);
        vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        const selectedEnv = {
          OPENCLAW_PROFILE: "selected",
          OPENCLAW_STATE_DIR: path.join(dir, "selected"),
        };
        const siblingEnv = {
          OPENCLAW_PROFILE: scenario.consumer ? "selected" : "sibling",
          OPENCLAW_STATE_DIR: path.join(dir, "sibling"),
          ...(scenario.consumer === "same-profile-other-service"
            ? {
                OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.other",
                OPENCLAW_SYSTEMD_UNIT: "openclaw-other",
                OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Other",
              }
            : {}),
        };
        const consumerEnv = scenario.consumer === "selected" ? selectedEnv : siblingEnv;
        const service = services.resolveGatewayService();
        const refuseMutation = vi.fn(async () => {
          throw new Error("Read-only sibling inspection cannot mutate a service");
        });
        vi.spyOn(services, "resolveGatewayService").mockReturnValue({
          ...service,
          stage: refuseMutation,
          install: refuseMutation,
          uninstall: refuseMutation,
          start: refuseMutation,
          stop: refuseMutation,
          restart: refuseMutation,
        });
        vi.spyOn(bindings, "discoverManagedGatewayBindings").mockResolvedValue([
          ...(scenario.unreadableFirst
            ? [
                {
                  profile: "unreadable",
                  env: { OPENCLAW_PROFILE: "unreadable" },
                  scope: "user" as const,
                },
              ]
            : []),
          { profile: consumerEnv.OPENCLAW_PROFILE, env: consumerEnv, scope: "user" },
        ]);
        let running = scenario.running && !scenario.late;
        const observedState = (
          env: Record<string, string>,
          live: boolean,
          location: string,
        ): GatewayServiceState => ({
          installed: true,
          loadState: { status: "loaded" },
          running: live,
          env,
          command: {
            programArguments: [
              process.execPath,
              path.join(location, "dist", "entry.js"),
              "gateway",
            ],
            environment: env,
            sourcePath: path.join(dir, "service-definition"),
          },
          runtime: {
            status: live ? "running" : "stopped",
            ...(live ? { pid: process.pid } : {}),
            systemd: { managerUid: 501 },
          },
        });
        vi.spyOn(services, "readGatewayServiceState").mockImplementation(async (_service, args) => {
          if (args?.env?.OPENCLAW_PROFILE === "unreadable") {
            throw new ServiceInspectionError("windows-task-inspection-failed");
          }
          const consumer = args?.env === consumerEnv;
          return observedState(
            consumer ? consumerEnv : selectedEnv,
            consumer && running,
            consumer ? otherRoot : root,
          );
        });
        const selectedVerdict = await inspectManagedGatewayServiceBeforeUpdate({
          root,
          state: observedState(selectedEnv, false, root),
        });
        mocks.maybeStopService.mockResolvedValue({
          inspected: true,
          runtimeInspected: true,
          stopped: false,
          running: false,
          serviceEnv: selectedEnv,
          serviceUpdateVerdict: selectedVerdict,
          serviceManagerUid: 501,
        });
        mocks.nativeSupport.mockResolvedValue(true);
        mocks.runPackageUpdate.mockImplementation(async ({ validateCandidate, beforeActivate }) => {
          await validateCandidate(candidate);
          if (scenario.late) {
            running = true;
          }
          await beforeActivate();
          await fs.writeFile(artifact, "replacement runtime");
          return successfulUpdate;
        });
        mocks.runGitUpdate.mockImplementation(
          async (
            options: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0],
          ) => {
            const target = { schemaVersions: { state: 15, agent: 19 } };
            await options.inspectGitTarget?.(target);
            await options.beforeGitMutation?.(target);
            await fs.writeFile(artifact, "replacement runtime");
            return { ...successfulUpdate, mode: "git" };
          },
        );
        const params = {
          ...executionParams(scenario.route ?? "package"),
          root,
          ...(scenario.consumer ? { shouldRestart: false } : {}),
        };
        const runId = createUpdateRun({ trigger: "cli" }, { env: selectedEnv }).runId;
        params.opts.run = { runId, env: selectedEnv };
        const execution = await withUpdateCommandExecutor(runId, async (executor) => {
          mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
            admitExecutor(await executor.enter(root));
          });
          return executeMutableUpdate(params);
        });
        expect(execution?.result.status).toBe(scenario.refused ? "error" : "ok");
        expect(await fs.readFile(artifact, "utf8")).toBe(
          scenario.refused ? "original runtime" : "replacement runtime",
        );
        expect(refuseMutation).not.toHaveBeenCalled();
        expect(running).toBe(scenario.running);
        expect(selectedVerdict.kind).toBe("owned");
        if (scenario.refused) {
          expect(execution?.mutationStarted).toBe(false);
          expect(execution?.result.steps).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                stderrTail: expect.stringContaining(consumerEnv.OPENCLAW_PROFILE),
              }),
            ]),
          );
        }
      });
    },
  );
}
