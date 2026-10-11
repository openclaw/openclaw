import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasActiveCronJobs } from "../../cron/active-jobs.js";
import { prepareCronRunAdmission } from "../../cron/run-admission.js";
import {
  createAccountCronScheduledToolPolicy,
  createTrustedCronScheduledToolPolicy,
} from "../../cron/scheduled-tool-policy.js";
import { CronService, type CronEvent } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import type { CronServiceDeps } from "../../cron/service/state.js";
import { saveCronStore } from "../../cron/store.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../methods/registry.js";
import { cronHandlers } from "./cron.js";
import type { GatewayRequestContext } from "./types.js";

const creatorSessionKey = "agent:main:telegram:direct:creator";
const creatorAccountId = "creator-account";

describe("cron self-removal through the automations tool", () => {
  it.each([
    { policy: "trusted", path: "manual" },
    { policy: "trusted", path: "timer" },
    { policy: "account", path: "manual" },
    { policy: "account", path: "timer" },
  ] as const)(
    "keeps the $path run of a current-target $policy job alive after it removes itself",
    async ({ policy, path }) => {
      await withOpenClawTestState({ prefix: "cron-self-removal-tool-" }, async (state) => {
        const cfg: OpenClawConfig = {
          agents: { entries: { main: {} }, defaults: { workspace: state.workspaceDir } },
          cron: { enabled: false },
        };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const storePath = state.statePath("cron", "jobs.json");
        await saveCronStore(storePath, { version: 1, jobs: [] });
        const clock = createGatewaySchedulerClock(Date.now());
        const scheduler = createTestGatewayScheduler(clock.clock);
        const events: CronEvent[] = [];
        const finished = createDeferred<CronEvent>();
        const gatewayWork = new AsyncWorkScope();
        const registry = createGatewayMethodRegistry(
          createCoreGatewayMethodDescriptors(cronHandlers),
        );
        let removeResult: unknown;
        let abortedAfterRemoval: boolean | undefined;
        let activeAfterRemoval: boolean | undefined;
        const runJob: CronServiceDeps["runIsolatedAgentJob"] = async ({
          job,
          abortSignal,
          executionIdentity,
          deliveryAttemptFence,
        }) => {
          const runId = `run-${job.id}`;
          const runSessionKey = `agent:main:cron:${job.id}:run:${runId}`;
          const admission = prepareCronRunAdmission({
            cfg,
            agentId: "main",
            runId,
            sessionKey: runSessionKey,
            jobId: job.id,
            deliveryAttemptFence,
            executionIdentity,
            resolveGatewayContext: () => context,
          });
          try {
            const admitted = await admission.preparedRunAdmission.admit("embedded");
            const callerIdentity = expectDefined(
              createAdmittedGatewayToolCallerIdentity({
                admittedRunContext: admitted,
                agentId: "main",
                sessionKey: runSessionKey,
                turnSourceAccountId: creatorAccountId,
              }),
              "admitted caller identity",
            );
            const tool = createCronTool({
              config: cfg,
              agentSessionKey: runSessionKey,
              agentId: "main",
              agentAccountId: creatorAccountId,
              selfRemoveOnlyJobId: job.id,
              runId,
            });
            const result = await withGatewayToolCallerIdentity(callerIdentity, () =>
              tool.execute("self-remove", { action: "remove", jobId: job.id }),
            );
            removeResult = result.details;
            abortedAfterRemoval = abortSignal?.aborted;
            activeAfterRemoval = hasActiveCronJobs();
            return {
              status: "ok" as const,
              summary: "final reply after self-cleanup",
              delivered: true,
            };
          } finally {
            await admission.finish();
          }
        };
        const cron = new CronService({
          scheduler,
          storePath,
          cronEnabled: true,
          defaultAgentId: "main",
          log: createNoopLogger(),
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          onEvent: (event) => {
            events.push(event);
            if (event.action === "finished") {
              finished.resolve(event);
            }
          },
          runIsolatedAgentJob: runJob,
        });
        const context = {
          cron,
          cronStorePath: storePath,
          trackExecution: gatewayWork.track.bind(gatewayWork),
          deps: {},
          getRuntimeConfig: () => cfg,
          getGatewayMethodRegistry: () => registry,
          logGateway: createNoopLogger(),
          validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
        } as unknown as GatewayRequestContext;
        context.resolveGatewayContext = () => context;
        try {
          const job = await cron.add(
            {
              name: "self-cleanup",
              enabled: true,
              deleteAfterRun: false,
              schedule: { kind: "at", at: new Date(clock.clock.now() + 1_000).toISOString() },
              sessionTarget: "current",
              sessionKey: creatorSessionKey,
              wakeMode: "next-heartbeat",
              payload: { kind: "agentTurn", message: "remove this job, then finish" },
              delivery: { mode: "announce" },
              owner: {
                agentId: "main",
                sessionKey: creatorSessionKey,
                accountId: creatorAccountId,
              },
            },
            {
              scheduledToolPolicy:
                policy === "account"
                  ? expectDefined(
                      createAccountCronScheduledToolPolicy({
                        ownerSessionKey: creatorSessionKey,
                        ownerAccountId: creatorAccountId,
                      }),
                      "account policy",
                    )
                  : createTrustedCronScheduledToolPolicy(),
            },
          );
          if (path === "manual") {
            await cron.run(job.id, "force");
          } else {
            await cron.start();
            await clock.advanceBy(1_000);
          }
          // Both trigger paths join the run's finalization; the finished event is the
          // run's own completion signal, so nothing here waits on wall time.
          await finished.promise;
          expect(events.filter((event) => event.action === "finished")).toEqual([
            expect.objectContaining({
              jobId: job.id,
              status: "ok",
              completionStatus: "succeeded",
              summary: "final reply after self-cleanup",
            }),
          ]);
          expect(hasActiveCronJobs()).toBe(false);
          expect(removeResult).toEqual({ ok: true, removed: true });
          expect(abortedAfterRemoval).toBe(false);
          expect(activeAfterRemoval).toBe(true);
          expect(await cron.readJob(job.id)).toBeUndefined();
        } finally {
          cron.stop();
          await scheduler.stop();
          await gatewayWork.drain();
        }
      });
    },
  );
});
