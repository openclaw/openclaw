import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { hasActiveCronJobs } from "../../cron/active-jobs.js";
import { CronService, type CronEvent } from "../../cron/service.js";
import { setupCronServiceSuite } from "../../cron/service.test-harness.js";
import type { CronServiceDeps } from "../../cron/service/state.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import {
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "../cron-creator-authority-grant.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { cronHandlers } from "./cron.js";
import type { GatewayClient, RespondFn } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-self-removal-" });

describe("cron self-removal", () => {
  it.each([
    { payloadKind: "agentTurn", path: "manual", timeoutSeconds: 0 },
    { payloadKind: "agentTurn", path: "timer", timeoutSeconds: 60 },
    { payloadKind: "script", path: "manual", timeoutSeconds: 0 },
    { payloadKind: "script", path: "timer", timeoutSeconds: 60 },
  ] as const)(
    "$payloadKind finishes its $path run with timeoutSeconds=$timeoutSeconds",
    async ({ payloadKind, path, timeoutSeconds }) => {
      const { storePath } = await makeStorePath();
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const events: CronEvent[] = [];
      let abortedAfterRemoval: boolean | undefined;
      let activeAfterRemoval: boolean | undefined;
      const runJob = async ({
        job,
        abortSignal,
        executionIdentity,
      }: Parameters<NonNullable<CronServiceDeps["runScriptJob"]>>[0]) => {
        const admission = prepareAgentRunAdmission({
          cfg: {},
          operationalRunInstance: createOperationalRunInstanceRef(`run-${job.id}`),
          facts: {
            runId: `run-${job.id}`,
            agentId: "main",
            ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
          },
        });
        const creatorScope = createCronCreatorAuthorityRunScope(`run-${job.id}`, { kind: "local" });
        try {
          const admitted = await admission.admit("embedded");
          await executionIdentity?.onPostAdmission?.(admitted);
          const delegatedAuthority = expectDefined(
            getAdmittedRunDelegatedAuthority(admitted),
            "live scheduled admission",
          );
          const client: GatewayClient = {
            connect: {} as GatewayClient["connect"],
            internal: {
              agentRuntimeIdentity: {
                kind: "agentRuntime",
                agentId: "main",
                sessionKey: `agent:main:cron:${job.id}`,
                operationalRunInstance: admitted.operationalRunInstance,
                delegatedAuthority: { kind: "local", ...delegatedAuthority },
                cronCreatorAuthorityGrant: mintCronCreatorAuthorityGrant(
                  creatorScope,
                  abortSignal,
                  undefined,
                  undefined,
                  "requester",
                ),
                cronSelfManagementContext: { jobId: job.id, expiresAtMs: Date.now() + 60_000 },
              },
            },
          };
          const respond = vi.fn<RespondFn>();
          const params = { id: job.id };
          await expectDefined(
            cronHandlers["cron.remove"],
            "cron.remove",
          )({
            req: { type: "req", id: "self-remove", method: "cron.remove", params },
            params,
            client,
            respond,
            context: createDirectChatContext({
              cron,
              cronStorePath: storePath,
              validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
            }),
            isWebchatConnect: () => false,
          });
          expect(respond).toHaveBeenCalledWith(true, { ok: true, removed: true }, undefined);
          abortedAfterRemoval = abortSignal?.aborted;
          activeAfterRemoval = hasActiveCronJobs();
          return {
            status: "ok" as const,
            summary: "final reply after self-cleanup",
            notify: "final reply after self-cleanup",
          };
        } finally {
          revokeCronCreatorAuthorityRunScope(creatorScope);
          admission.close();
        }
      };
      const cron = new CronService({
        scheduler,
        storePath,
        cronEnabled: true,
        defaultAgentId: "main",
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        onEvent: (event) => events.push(event),
        runIsolatedAgentJob: runJob,
        runScriptJob: runJob,
      });
      try {
        const job = await cron.add(
          {
            name: "self-cleanup",
            enabled: true,
            deleteAfterRun: false,
            schedule: { kind: "at", at: new Date(clock.clock.now() + 1_000).toISOString() },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload:
              payloadKind === "script"
                ? { kind: "script", script: "return {}", timeoutSeconds }
                : { kind: "agentTurn", message: "remove this job, then finish", timeoutSeconds },
            delivery: { mode: "none" },
          },
          { scheduledToolPolicy: { version: 1, mode: "trusted" } },
        );
        if (path === "manual") {
          await cron.run(job.id, "force");
        } else {
          await cron.start();
          await clock.advanceBy(1_000);
        }
        await vi.waitFor(() => {
          expect(events.filter((event) => event.action === "finished")).toEqual([
            expect.objectContaining({
              jobId: job.id,
              status: "ok",
              completionStatus: "succeeded",
              summary: "final reply after self-cleanup",
            }),
          ]);
          expect(abortedAfterRemoval).toBe(false);
          expect(activeAfterRemoval).toBe(true);
          expect(hasActiveCronJobs()).toBe(false);
        });
        expect(await cron.readJob(job.id)).toBeUndefined();
      } finally {
        cron.stop();
        await scheduler.stop();
      }
    },
  );

  it.each([
    { gap: "different operational instance", path: "manual" },
    { gap: "different operational instance", path: "timer" },
    { gap: "unbound admission", path: "manual" },
    { gap: "unbound admission", path: "timer" },
  ] as const)(
    "refuses a self-targeted removal that cannot prove the exact live owner ($gap, $path) instead of cancelling the run",
    async ({ gap, path }) => {
      const { storePath } = await makeStorePath();
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const events: CronEvent[] = [];
      let abortedAfterRemoval: boolean | undefined;
      let removalResponse: Parameters<RespondFn> | undefined;
      const runJob = async ({
        job,
        abortSignal,
        executionIdentity,
      }: Parameters<NonNullable<CronServiceDeps["runIsolatedAgentJob"]>>[0]) => {
        const admission = prepareAgentRunAdmission({
          cfg: {},
          operationalRunInstance: createOperationalRunInstanceRef(`run-${job.id}`),
          facts: {
            runId: `run-${job.id}`,
            agentId: "main",
            ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
          },
        });
        const creatorScope = createCronCreatorAuthorityRunScope(`run-${job.id}`, { kind: "local" });
        try {
          const admitted = await admission.admit("embedded");
          if (gap !== "unbound admission") {
            await executionIdentity?.onPostAdmission?.(admitted);
          }
          const delegatedAuthority = expectDefined(
            getAdmittedRunDelegatedAuthority(admitted),
            "live scheduled admission",
          );
          const client: GatewayClient = {
            connect: {} as GatewayClient["connect"],
            internal: {
              agentRuntimeIdentity: {
                kind: "agentRuntime",
                agentId: "main",
                sessionKey: `agent:main:cron:${job.id}`,
                operationalRunInstance:
                  gap === "different operational instance"
                    ? createOperationalRunInstanceRef(`run-${job.id}`)
                    : admitted.operationalRunInstance,
                delegatedAuthority: { kind: "local", ...delegatedAuthority },
                cronCreatorAuthorityGrant: mintCronCreatorAuthorityGrant(
                  creatorScope,
                  abortSignal,
                  undefined,
                  undefined,
                  "requester",
                ),
                cronSelfManagementContext: { jobId: job.id, expiresAtMs: Date.now() + 60_000 },
              },
            },
          };
          const respond = vi.fn<RespondFn>();
          const params = { id: job.id };
          await expectDefined(
            cronHandlers["cron.remove"],
            "cron.remove",
          )({
            req: { type: "req", id: "self-remove", method: "cron.remove", params },
            params,
            client,
            respond,
            context: createDirectChatContext({
              cron,
              cronStorePath: storePath,
              validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
            }),
            isWebchatConnect: () => false,
          });
          removalResponse = respond.mock.calls[0];
          abortedAfterRemoval = abortSignal?.aborted;
          return {
            status: "ok" as const,
            summary: "final reply after refused self-cleanup",
            notify: "final reply after refused self-cleanup",
          };
        } finally {
          revokeCronCreatorAuthorityRunScope(creatorScope);
          admission.close();
        }
      };
      const cron = new CronService({
        scheduler,
        storePath,
        cronEnabled: true,
        defaultAgentId: "main",
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        onEvent: (event) => events.push(event),
        runIsolatedAgentJob: runJob,
      });
      try {
        const job = await cron.add(
          {
            name: "refused-self-cleanup",
            enabled: true,
            deleteAfterRun: false,
            schedule: { kind: "at", at: new Date(clock.clock.now() + 1_000).toISOString() },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "agentTurn", message: "remove this job, then finish" },
            delivery: { mode: "none" },
          },
          { scheduledToolPolicy: { version: 1, mode: "trusted" } },
        );
        if (path === "manual") {
          await cron.run(job.id, "force");
        } else {
          await cron.start();
          await clock.advanceBy(1_000);
        }
        await vi.waitFor(() => {
          expect(events.filter((event) => event.action === "finished")).toEqual([
            expect.objectContaining({
              jobId: job.id,
              status: "ok",
              completionStatus: "succeeded",
              summary: "final reply after refused self-cleanup",
            }),
          ]);
          expect(hasActiveCronJobs()).toBe(false);
        });
        const [ok, payload, error] = expectDefined(removalResponse, "removal response");
        expect(ok).toBe(false);
        expect(payload).toBeUndefined();
        expect(error).toMatchObject({
          message: expect.stringContaining("still running"),
        });
        expect(abortedAfterRemoval).toBe(false);
        // The refused removal keeps the job; a fired one-shot without deleteAfterRun is retained disabled.
        expect(await cron.readJob(job.id)).toMatchObject({
          id: job.id,
          enabled: path === "manual",
        });
      } finally {
        cron.stop();
        await scheduler.stop();
      }
    },
  );
});
