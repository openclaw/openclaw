import "../../snapshot/database-backup.js";
import "../../infra/backup-sqlite-snapshot.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as bindings from "../../daemon/managed-gateway-bindings.js";
import { ServiceInspectionError } from "../../daemon/service-inspection-error.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import * as services from "../../daemon/service.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { writeFixtureJson } from "../cli-fixtures.test-support.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import {
  bindExecutionGuards,
  executionParams,
  mocks,
  schemaContext,
  successfulUpdate,
} from "./update-command-execution.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { updateGitInstall } from "./update-command-git.js";
import { inspectManagedGatewayServiceBeforeUpdate } from "./update-command-service-plan.js";
import * as verification from "./update-command-verification.js";

type Candidate = { validateCandidate: (root: string) => Promise<unknown> };

async function executeOwned(
  dir: string,
  params: ReturnType<typeof executionParams>,
  env: NodeJS.ProcessEnv,
) {
  const control = path.join(dir, "leases");
  await fs.mkdir(control);
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
  params.opts.run = { runId, env };
  return withUpdateCommandExecutor(runId, async (executor) => {
    mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
      admitExecutor(await executor.enter(params.root));
    });
    return executeMutableUpdate(await bindExecutionGuards(params));
  });
}

function expectBeforeActivation() {
  expect(mocks.serviceStopped).toBe(false);
  expect(mocks.validateCanary).not.toHaveBeenCalled();
}

export function registerNativeAdmissionTests() {
  it.each(["auto", "installed", "git-to-package"] as const)(
    "refuses an engine-incompatible package before publication with %s admission",
    async (route) =>
      withTestDir({ prefix: "engine-before-activation-" }, async (dir) => {
        const anchor = path.join(dir, "plugins", "workboard", "workboard.sqlite");
        const candidate = path.join(dir, "candidate");
        await fs.mkdir(path.dirname(anchor), { recursive: true });
        await fs.mkdir(candidate);
        await fs.writeFile(path.join(candidate, "package.json"), '{"name":"openclaw"}');
        const runtime = path.join(dir, "entry.js");
        await fs.writeFile(runtime, "original runtime");
        {
          using db = openNodeSqliteDatabase(anchor);
          db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
          db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, ?, ?)").run(
            "e3b4e990-c0f1-4ec7-a5d1-4e1c6824f80f",
            "postgres",
            "retained_workboard",
          );
        }
        const before = await fs.readFile(anchor);
        const context = schemaContext("default");
        const env = { OPENCLAW_STATE_DIR: dir };
        mocks.captureSchemaContext.mockResolvedValue({
          ...context,
          env,
          readEnv: env,
          config: { plugins: { entries: { workboard: { enabled: true } } } },
        });
        mocks.captureManagedPreflight.mockResolvedValue(undefined);
        const params = executionParams("package");
        params.root = dir;
        if (route === "git-to-package") {
          params.installKind = "git";
        } else if (route === "installed") {
          params.opts.admission = "installed";
        }
        const events: string[] = [];
        mocks.runPackageUpdate.mockImplementation(async ({ validateCandidate }: Candidate) => {
          await validateCandidate(candidate);
          events.push("publish");
          return successfulUpdate;
        });
        const result = await executeMutableUpdate(await bindExecutionGuards(params));
        expect(result?.result).toMatchObject({
          status: "error",
          reason: "database-engine-preflight",
        });
        expect(events).toEqual([]);
        expectBeforeActivation();
        expect(await fs.readFile(anchor)).toEqual(before);
        expect(await fs.readdir(path.dirname(anchor))).toEqual(["workboard.sqlite"]);
        expect(await fs.readFile(runtime, "utf8")).toBe("original runtime");
      }),
  );

  it.each(["package", "staged", "git"] as const)(
    "refuses an unsupported native receiver before activation: %s",
    async (route) =>
      withTestDir({ prefix: "native-before-activation-" }, async (dir) => {
        const env = { OPENCLAW_STATE_DIR: dir };
        const params = executionParams(route === "git" ? "git" : "package");
        params.root = dir;
        params.updateStepTimeoutMs = 600_000;
        if (route === "staged") {
          params.packageInstallSpec = path.join(dir, "candidate.tgz");
        }
        const events: string[] = [];
        mocks.nativeSupport.mockImplementation(async ({ executor }) => {
          executor.assertCurrent();
          events.push("native-admission");
          return false;
        });
        const candidate = async ({ validateCandidate }: Candidate) => {
          await validateCandidate(dir);
          // Models the package/Git publisher which follows successful validation.
          events.push("publish");
          return successfulUpdate;
        };
        mocks.runPackageUpdate.mockImplementation(candidate);
        mocks.runGitUpdate.mockImplementation(
          async (options: Parameters<typeof updateGitInstall>[0]) => {
            if (!options.inspectGitTarget || !options.validateCandidate) {
              throw new Error("Missing actual Git admission callbacks");
            }
            await options.inspectGitTarget({ schemaVersions: { state: 15, agent: 19 } });
            return candidate({ validateCandidate: options.validateCandidate });
          },
        );
        const result = await executeOwned(dir, params, env);
        expect(result?.result).toMatchObject({
          status: "error",
          reason: "target-native-unsupported",
        });
        expect(events).toEqual(["native-admission"]);
        expect(mocks.nativeSupport.mock.calls[0]?.[0]).toMatchObject({
          timeoutMs: params.updateStepTimeoutMs,
        });
        expectBeforeActivation();
      }),
  );

  type ConsumerCase = {
    shared?: boolean;
    linkedDist?: boolean;
    running?: boolean;
    late?: boolean;
    refused?: boolean;
    route?: "git";
    consumer?: "selected" | "same-profile-other-service";
    unreadableFirst?: boolean;
    selectedRunning?: boolean;
    startsDuringStop?: boolean;
  };
  const consumerCases: [string, ConsumerCase][] = [
    ["live shared root", {}],
    ["stopped shared root", { running: false, refused: false }],
    ["live disjoint root", { shared: false, refused: false }],
    ["selected live + shared sibling", { selectedRunning: true }],
    ["selected live + disjoint sibling", { shared: false, refused: false, selectedRunning: true }],
    ["sibling starts during selected stop", { selectedRunning: true, startsDuringStop: true }],
    ["disjoint roots, shared entrypoint", { shared: false, linkedDist: true }],
    ["sibling starts during staging", { late: true }],
    ["Git shared publication", { route: "git" }],
    ["selected package no-restart", { consumer: "selected", refused: false }],
    ["same-profile other service", { consumer: "same-profile-other-service" }],
    ["unreadable unrelated definition", { unreadableFirst: true, shared: false, refused: false }],
    ["live sibling after unreadable definition", { unreadableFirst: true }],
  ];
  it.each(consumerCases)(
    "protects managed consumers before publication: %s",
    async (_name, overrides) => {
      const scenario = { shared: true, running: true, late: false, refused: true, ...overrides };
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
          await writeFixtureJson(path.join(location, "package.json"), {
            name: "openclaw",
            version: location === candidate ? "1.0.1" : "1.0.0",
          });
          await fs.writeFile(path.join(location, "dist", "entry.js"), "original runtime");
        }
        if (scenario.linkedDist) {
          await fs.rm(path.join(otherRoot, "dist"), { recursive: true });
          await fs.symlink(path.join(root, "dist"), path.join(otherRoot, "dist"), "junction");
        }
        const artifact = path.join(root, "dist", "entry.js");
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
                  env: { OPENCLAW_PROFILE: "unreadable" },
                  scope: "user" as const,
                },
              ]
            : []),
          { env: consumerEnv, scope: "user" },
        ]);
        let running = scenario.running && !scenario.late && !scenario.startsDuringStop;
        let selectedRunning = scenario.selectedRunning ?? false;
        if (scenario.selectedRunning) {
          vi.spyOn(verification, "verifyPreviousManagedGatewayForUpdate").mockImplementation(
            async (params) => {
              params.assertCurrent?.();
              params.onVerification(true);
            },
          );
        }
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
          const isConsumer = args?.env === consumerEnv;
          return observedState(
            isConsumer ? consumerEnv : selectedEnv,
            isConsumer ? running : selectedRunning,
            isConsumer ? otherRoot : root,
          );
        });
        const selectedVerdict = await inspectManagedGatewayServiceBeforeUpdate({
          root,
          state: observedState(selectedEnv, false, root),
        });
        mocks.maybeStopService.mockImplementation(async ({ phase, shouldRestart }) => {
          const wasRunning = selectedRunning;
          const stopped = phase !== "inspect" && shouldRestart && selectedRunning;
          if (stopped) {
            selectedRunning = false;
            mocks.serviceStopped = true;
            if (scenario.startsDuringStop) {
              running = true;
            }
          }
          return {
            inspected: true,
            runtimeInspected: true,
            stopped,
            running: wasRunning,
            serviceEnv: selectedEnv,
            serviceUpdateVerdict: selectedVerdict,
            serviceManagerUid: 501,
          };
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
          async (options: Parameters<typeof updateGitInstall>[0]) => {
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
        const execution = await executeOwned(dir, params, selectedEnv);
        expect(execution?.result.status).toBe(scenario.refused ? "error" : "ok");
        expect(await fs.readFile(artifact, "utf8")).toBe(
          scenario.refused ? "original runtime" : "replacement runtime",
        );
        expect(refuseMutation).not.toHaveBeenCalled();
        expect(running).toBe(scenario.running);
        expect(selectedVerdict.kind).toBe("owned");
        if (scenario.selectedRunning) {
          expect(mocks.serviceStopped).toBe(
            !scenario.refused || Boolean(scenario.startsDuringStop),
          );
          expect(selectedRunning).toBe(scenario.refused && !scenario.startsDuringStop);
        }
        if (scenario.refused) {
          expect(execution?.mutationStarted).toBe(false);
          expect(execution?.result.steps).toContainEqual(
            expect.objectContaining({
              stderrTail: expect.stringContaining(
                scenario.consumer === "same-profile-other-service"
                  ? process.platform === "win32"
                    ? "OpenClaw Other"
                    : "openclaw-other"
                  : consumerEnv.OPENCLAW_PROFILE,
              ),
            }),
          );
        }
      });
    },
  );
}
