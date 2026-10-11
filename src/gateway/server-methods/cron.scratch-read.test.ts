import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { writeCronJobScratchInDatabase } from "../../cron/scratch-write.kernel.js";
import { CronService } from "../../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { upsertCronJobRow } from "../../cron/store/row-codec.js";
import type { CronJob } from "../../cron/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { cronHandlers } from "./cron.js";
import {
  createCronCallerClient as callerClient,
  createCronTestContext,
  createCronTestInvoker,
} from "./cron.validation.test-support.js";

const cronLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "cron-scratch-read-" });
const getRuntimeConfig = () => ({});
const invokeCron = createCronTestInvoker(cronHandlers, getRuntimeConfig);
const createCronContext = (job: CronJob) => createCronTestContext(job, getRuntimeConfig);

describe("cron scratch read authority", () => {
  it.each(["caller closes after read", "owner transfers before read"] as const)(
    "withholds private scratch when %s",
    async (change) => {
      const { storePath } = await makeStorePath();
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        nowMs: () => Date.now(),
        storePath,
        cronEnabled: true,
        defaultAgentId: "main",
        log: cronLogger,
        enqueueSystemEvent: vi.fn(),
        enqueueSessionEvent: vi.fn(),
        runIsolatedAgentJob: async () => ({ status: "skipped" }),
      });
      const entered = createDeferred();
      const release = createDeferred();
      let invocation: Promise<unknown> | undefined;
      try {
        const owner = { agentId: "ops", sessionKey: "agent:ops:main", accountId: "work" };
        const scheduledToolPolicy = {
          version: 1 as const,
          mode: "account" as const,
          ownerSessionKey: owner.sessionKey,
          ownerAccountId: owner.accountId,
        };
        const job = await cron.add(
          {
            id: "scratch-read-owner",
            name: "scratch read owner",
            agentId: "ops",
            owner,
            enabled: false,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "agentTurn", message: "synthetic event", toolsAllow: ["read"] },
          },
          { scheduledToolPolicy },
        );
        await cron.writeScratch(job.id, {
          content: "original private scratch",
          expectedRevision: 0,
        });
        const context = createCronContext(job);
        context.cron.readJob.mockImplementation((id) => cron.readJob(id));
        context.cron.getJob.mockImplementation((id) => cron.getJob(id));
        const client = callerClient("ops", owner.accountId, owner.sessionKey);
        context.cron.readScratch.mockImplementation((...args) => cron.readScratch(...args));
        const permitted = await invokeCron("cron.scratch.get", { id: job.id }, { context, client });
        expect(permitted.respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            currentRevision: 1,
            scratch: expect.objectContaining({ content: "original private scratch" }),
          }),
          undefined,
        );
        context.cron.readScratch.mockClear();
        let current = true;
        context.cron.readScratch.mockImplementation(async (...args) => {
          if (change === "owner transfers before read") {
            entered.resolve();
            await release.promise;
          }
          const result = await cron.readScratch(...args);
          if (change === "caller closes after read") {
            current = false;
          }
          return result;
        });
        const respond = vi.fn();
        invocation = invokeCron(
          "cron.scratch.get",
          { id: job.id },
          {
            context,
            respond,
            client,
            hasCurrentClientAuthority: () => current,
          },
        ).then(
          () => ({ rejected: false }),
          (error: unknown) => ({ rejected: true, error }),
        );
        if (change === "owner transfers before read") {
          expect(
            await Promise.race([
              entered.promise.then(() => "scope-checked"),
              invocation.then(() => "completed-before-read"),
            ]),
          ).toBe("scope-checked");
          const peer = new DatabaseSync(resolveOpenClawStateSqlitePath());
          try {
            runSqliteImmediateTransactionSync(peer, () => {
              upsertCronJobRow(
                peer,
                cronStoreKey(storePath),
                {
                  ...job,
                  agentId: "worker",
                  owner: { agentId: "worker", sessionKey: "agent:worker:main", accountId: "work" },
                  scheduledToolPolicy: {
                    ...scheduledToolPolicy,
                    ownerSessionKey: "agent:worker:main",
                  },
                },
                0,
              );
              expect(
                writeCronJobScratchInDatabase(peer, {
                  storeKey: cronStoreKey(storePath),
                  jobId: job.id,
                  content: "peer private scratch",
                  expectedRevision: 1,
                  nowMs: Date.now(),
                }).result.ok,
              ).toBe(true);
            });
          } finally {
            peer.close();
          }
          expect(
            (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id)?.agentId,
          ).toBe("worker");
          expect(cron.getJob(job.id)?.agentId).toBe("ops");
          release.resolve();
        }
        const result = await invocation;
        expect(context.cron.readScratch).toHaveBeenCalledOnce();
        if (change === "caller closes after read") {
          expect.soft(result).toMatchObject({
            rejected: true,
            error: { message: expect.stringContaining("authority closed") },
          });
          expect(respond).not.toHaveBeenCalled();
        } else {
          expect.soft(respond.mock.calls.some(([ok]) => ok === true)).toBe(false);
          expect(JSON.stringify(respond.mock.calls)).not.toContain("peer private scratch");
        }
      } finally {
        release.resolve();
        await invocation;
        cron.stop();
      }
    },
  );
});

async function withScheduledScratch(
  run: (fixture: {
    cron: CronService;
    job: CronJob;
    foreign: CronJob;
    context: ReturnType<typeof createDirectChatContext>;
    client: ReturnType<typeof callerClient>;
    retireInvocation: () => void;
    releaseClaim: () => void;
  }) => Promise<void>,
) {
  const { storePath } = await makeStorePath();
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: false,
    defaultAgentId: "worker",
    log: cronLogger,
    enqueueSystemEvent: vi.fn(),
    enqueueSessionEvent: vi.fn(),
    runIsolatedAgentJob: async () => ({ status: "skipped" }),
  });
  const operationalRunInstance = createOperationalRunInstanceRef("scratch-scheduled-run");
  let invocationCurrent = true;
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance, () => {
    if (!invocationCurrent) {
      throw new Error("Scheduled invocation closed");
    }
  });
  try {
    const addJob = (id: string) =>
      cron.add(
        {
          id,
          name: id,
          agentId: "worker",
          owner: { agentId: "operator", sessionKey: "agent:operator:main" },
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Check the synthetic queue" },
          delivery: { mode: "none" },
        },
        { scheduledToolPolicy: { version: 1, mode: "trusted" } },
      );
    const job = await addJob("scheduled-scratch");
    const foreign = await addJob("foreign-scratch");
    await cron.writeScratch(job.id, { content: "retained checklist", expectedRevision: 0 });
    await cron.writeScratch(foreign.id, {
      content: "foreign private checklist",
      expectedRevision: 0,
    });
    const context = createDirectChatContext({
      cron,
      cronStorePath: storePath,
      getRuntimeConfig,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    });
    const client = callerClient("worker", undefined, `agent:worker:cron:${job.id}`, job.id);
    const identity = client.internal?.agentRuntimeIdentity;
    if (!identity) {
      throw new Error("Scheduled scratch fixture has no caller identity");
    }
    identity.operationalRunInstance = operationalRunInstance;
    identity.delegatedAuthority = { ...authority, kind: "local" };
    await run({
      cron,
      job,
      foreign,
      context,
      client,
      retireInvocation: () => {
        invocationCurrent = false;
      },
      releaseClaim: () => releaseAgentRunDelegatedAuthority(authority),
    });
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
    cron.stop();
  }
}

async function invokeScheduledScratch(
  method: "cron.scratch.get" | "cron.scratch.set",
  params: Record<string, unknown>,
  caller: {
    context: ReturnType<typeof createDirectChatContext>;
    client: ReturnType<typeof callerClient>;
  },
) {
  const respond = vi.fn();
  await cronHandlers[method]!({
    req: { type: "req", id: "scheduled-scratch", method },
    params,
    respond,
    ...caller,
    isWebchatConnect: () => false,
  });
  return { respond };
}

describe("scheduled automation scratch RPC", () => {
  it("reads and CAS-writes its own checklist across owner scope without exposing another job", async () => {
    await withScheduledScratch(async ({ cron, job, foreign, context, client }) => {
      const read = await invokeScheduledScratch(
        "cron.scratch.get",
        { id: job.id },
        { context, client },
      );
      expect(read.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          currentRevision: 1,
          scratch: expect.objectContaining({ content: "retained checklist" }),
        }),
        undefined,
      );
      const write = await invokeScheduledScratch(
        "cron.scratch.set",
        {
          id: job.id,
          content: "checked queue",
          expectedRevision: 1,
        },
        { context, client },
      );
      expect(write.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          ok: true,
          currentRevision: 2,
        }),
        undefined,
      );
      const stale = await invokeScheduledScratch(
        "cron.scratch.set",
        {
          id: job.id,
          content: "stale replacement",
          expectedRevision: 1,
        },
        { context, client },
      );
      expect(stale.respond).toHaveBeenCalledWith(
        true,
        {
          ok: false,
          reason: "revision-conflict",
          currentRevision: 2,
        },
        undefined,
      );
      for (const method of ["cron.scratch.get", "cron.scratch.set"] as const) {
        const denied = await invokeScheduledScratch(
          method,
          {
            id: foreign.id,
            ...(method === "cron.scratch.set"
              ? { content: "must not write", expectedRevision: 1 }
              : {}),
          },
          { context, client },
        );
        expect(denied.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
          }),
        );
        expect(JSON.stringify(denied.respond.mock.calls)).not.toContain(
          "foreign private checklist",
        );
      }
      expect(await cron.readScratch(job.id)).toMatchObject({
        currentRevision: 2,
        scratch: { content: "checked queue" },
      });
      expect(await cron.readScratch(foreign.id)).toMatchObject({
        currentRevision: 1,
        scratch: { content: "foreign private checklist" },
      });
    });
  });

  it.each(["invocation closes", "claim is released"] as const)(
    "rejects a scratch write when the %s after worker preparation before dispatch",
    async (transition) => {
      await withScheduledScratch(
        async ({ cron, job, context, client, retireInvocation, releaseClaim }) => {
          const runWorker = stateWorker.runOpenClawStateWorkerOperation;
          let dispatchObserved = false;
          const admission = vi
            .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
            .mockImplementationOnce((workerContext, operation, options) =>
              runWorker(
                workerContext,
                (scope) => {
                  dispatchObserved = true;
                  if (transition === "invocation closes") {
                    retireInvocation();
                  } else {
                    releaseClaim();
                  }
                  return operation(scope);
                },
                options,
              ),
            );
          try {
            const write = await invokeScheduledScratch(
              "cron.scratch.set",
              {
                id: job.id,
                content: "must not commit",
                expectedRevision: 1,
              },
              { context, client },
            );
            expect(dispatchObserved).toBe(true);
            expect(
              client.internal?.agentRuntimeIdentity?.cronSelfManagementContext?.expiresAtMs,
            ).toBeGreaterThan(Date.now());
            expect(write.respond).toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({
                message: expect.stringContaining("authority is no longer active"),
              }),
            );
          } finally {
            admission.mockRestore();
          }
          expect(await cron.readScratch(job.id)).toMatchObject({
            currentRevision: 1,
            scratch: { content: "retained checklist" },
          });
        },
      );
    },
  );
});
