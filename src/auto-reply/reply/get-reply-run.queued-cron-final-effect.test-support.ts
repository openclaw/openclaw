// Queue-produced authority through the production in-process dispatcher and SQLite.
// Only model execution is replaced. This is not a network or real-LLM proof.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import { withPreparedEmbeddedGatewayTools } from "../../agents/embedded-agent-runner/run/attempt-gateway-tools.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { CronService, type CronEvent } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronStore } from "../../cron/store.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import { getCronManagementAuthority } from "../../gateway/cron-creator-authority-grant.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../gateway/methods/registry.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { cronHandlers } from "../../gateway/server-methods/cron.js";
import type { GatewayRequestHandlers } from "../../gateway/server-methods/types.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  captureCommandOwnerAssertion,
  getCommandOwnerAuthority,
} from "../command-owner-authority.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { prepareChannelRunAdmission } from "./channel-run-admission.js";
import {
  createFollowupTurnTestTurn,
  getFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import type { runPreparedReply } from "./get-reply-run.js";
import { ownerParams } from "./get-reply-run.test-support.js";
import type { FollowupRun } from "./queue.js";

type OwnerFixture = Parameters<Parameters<typeof withAdminIngress>[0]>[0];
type OwnerContext = Awaited<ReturnType<OwnerFixture["context"]>>;
type Turn = ReturnType<typeof createFollowupTurnTestTurn>;
type SourceOptions = Partial<Parameters<typeof runPreparedReply>[0]>;

export type QueuedCronFinalEffectHarness = {
  captureSource: (
    context: OwnerContext,
    cfg: OwnerFixture["cfg"],
    overrides?: SourceOptions,
  ) => Promise<{ queued: FollowupRun }>;
  execute: (turn: Turn) => Promise<unknown>;
  collectQueuedInputs: (
    inputs: FollowupRun[],
    count?: number,
    beforeDrain?: () => void,
    onRun?: (queued: FollowupRun) => Promise<void>,
  ) => Promise<FollowupRun[]>;
};

function createFinalEffectStore(owner: OwnerFixture) {
  const storePath = owner.state.statePath("cron", "jobs.json");
  const events: CronEvent[] = [];
  const entered: Array<{
    method: string;
    params: unknown;
    runId?: string;
    instanceId?: string;
    management: boolean;
  }> = [];
  const work = new AsyncWorkScope();
  let beforeValidation: (() => Promise<void>) | undefined;
  let activeUpdateIdentity: AgentRuntimeIdentity | undefined;
  const service = new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: false,
    defaultAgentId: "main",
    log: createNoopLogger(),
    enqueueSystemEvent: () => {
      throw new Error("manual management proof must not execute a job");
    },
    requestHeartbeat: () => {
      throw new Error("manual management proof must not request a heartbeat");
    },
    runIsolatedAgentJob: async () => {
      throw new Error("manual management proof must not run an agent");
    },
    listConfiguredChannels: async () => {
      if (beforeValidation) {
        // cronHandlers has already redeemed the real grant before entering the store lock.
        const assertManagement = expectDefined(
          getCronManagementAuthority(expectDefined(activeUpdateIdentity, "runtime identity")),
          "redeemed management authority at Cron validation",
        );
        assertManagement();
        await beforeValidation();
      }
      return [];
    },
    onEvent: (event) => events.push(event),
  });
  const observedHandlers: GatewayRequestHandlers = {};
  for (const [method, handler] of Object.entries(cronHandlers)) {
    // Pass-through observation only: no authorization, response, or mutation is supplied here.
    observedHandlers[method] = (args) => {
      const identity = args.client?.internal?.agentRuntimeIdentity;
      entered.push({
        method,
        params: args.params,
        ...identity?.operationalRunInstance,
        management: Boolean(identity?.cronManagementGrant),
      });
      if (method === "cron.update") {
        activeUpdateIdentity = identity;
      }
      return handler(args);
    };
  }
  const registry = createGatewayMethodRegistry(
    createCoreGatewayMethodDescriptors(observedHandlers),
  );
  // Enrich the original object; its channel ingress owner must retain the exact same host.
  Object.assign(
    owner.gateway,
    createDirectChatContext({
      cron: service,
      cronStorePath: storePath,
      getRuntimeConfig: () => owner.cfg,
      getGatewayMethodRegistry: () => registry,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      trackExecution: work.track.bind(work),
      resolveGatewayContext: () => owner.gateway,
    }),
  );
  const read = async () => (await loadCronStore(storePath)).jobs;
  return {
    service,
    entered,
    events,
    read,
    hold: (callback: () => Promise<void>) => {
      beforeValidation = callback;
    },
    settle: () => work.runWhenIdle(() => undefined),
    async close() {
      service.stop();
      await work.drain();
    },
  };
}

async function withModelSelectedAutomation(
  params: AgentTurnParams,
  owner: OwnerFixture,
  run: (tool: ReturnType<typeof createCronTool>) => Promise<void>,
) {
  const queued = params.followupRun;
  const runId = expectDefined(params.opts?.runId, "queued execution runId");
  const sessionKey = expectDefined(queued.run.sessionKey, "queued session");
  const preparation = prepareChannelRunAdmission({
    cfg: owner.cfg,
    runId,
    agentId: queued.run.agentId,
    ingressKind: "channel",
    boundary: "auto-reply.agent-runner",
    evidence: queued.channelAdmissionEvidence,
    gatewayLocalUserIngress: queued.gatewayLocalUserIngress,
    operatorAuthority: queued.operatorAuthority,
    assertSourceCurrent: queued.run.senderIsOwner
      ? captureCommandOwnerAssertion(queued.run)
      : undefined,
    onAdmitted: (admitted) => bindGatewayContextResolver(admitted, () => owner.gateway),
  });
  let admitted: AdmittedRunContext | undefined;
  try {
    admitted = await preparation.admit("embedded");
    const currentAdmission = admitted;
    // executeFollowupTurn owns the active scope. Never construct a substitute capability here.
    await withPreparedEmbeddedGatewayTools(
      {
        admittedRunContext: admitted,
        cronCreatorAuthorityCapability: params.opts?.cronCreatorAuthorityCapability,
        agentId: queued.run.agentId,
        sessionKey,
        sessionId: queued.run.sessionId,
        agentHarnessId: "openclaw",
        messageProvider: queued.run.messageProvider,
        agentAccountId: queued.run.agentAccountId,
      },
      () => getAdmittedRunDelegatedAuthority(currentAdmission) !== undefined,
      async () => {
        const caller = expectDefined(getGatewayToolCallerIdentity(), "prepared production caller");
        expect(caller.operationalRunInstance).toBe(currentAdmission.operationalRunInstance);
        expect(caller.approvalAuthority).toBe(getAdmittedRunDelegatedAuthority(currentAdmission));
        expect(caller.gatewayContextResolver?.()).toBe(owner.gateway);
        const tool = createCronTool({
          runId,
          agentSessionKey: sessionKey,
          agentAccountId: queued.run.agentAccountId,
          config: owner.cfg,
        });
        await run(tool);
      },
    );
  } finally {
    if (admitted) {
      clearGatewayContextResolver(admitted);
    }
    preparation.close();
  }
}

export function registerQueuedCronFinalEffectCases(harness: QueuedCronFinalEffectHarness) {
  const execution = getFollowupTurnTestState();
  describe("queued automation authority at the real in-process Cron commit boundary", () => {
    it.for([
      "owner",
      "verified-member",
      "unverified",
      "revoke-after-bind",
      "cancel-after-bind",
      "collected-first-source-retired",
    ] as const)("persists exactly the authorized management effects: %s", async (kind, test) => {
      await withAdminIngress(
        async (owner) => {
          owner.cfg.agents = {
            entries: { main: {} },
            defaults: { workspace: owner.state.workspaceDir },
          };
          setRuntimeConfigSnapshot(owner.cfg);
          const store = createFinalEffectStore(owner);
          const release = createDeferred();
          const reached = createDeferred();
          const cancelled = new AbortController();
          let pending: Promise<FollowupRun[]> | undefined;
          try {
            const sender = kind === "verified-member" ? owner.admins[1]! : owner.admins[0]!;
            if (kind === "verified-member") {
              setUserProfileRole(sender.profile.id, "member");
            }
            const context = await owner.context(
              sender.identity.senderId,
              kind !== "unverified",
              "team",
              "first-source",
            );
            const isOwner = kind !== "verified-member" && kind !== "unverified";
            expect(Boolean(getCommandOwnerAuthority(context)?.isCurrent())).toBe(isOwner);
            const sessionKey = expectDefined(
              context.SessionKey,
              "original canonical source session",
            );
            const sourceOptions: SourceOptions = {
              agentId: "main",
              sessionKey,
              sessionEntry: { sessionId: "queued-final-effect-session", updatedAt: 1 },
              command: {
                ...ownerParams().command,
                senderId: context.SenderId,
                senderIsOwner: isOwner,
              },
            };
            const source = await harness.captureSource(context, owner.cfg, sourceOptions);
            const fork = kind === "collected-first-source-retired" ? owner.forkSource() : undefined;
            const second = fork
              ? await harness.captureSource(
                  await fork.context(sender.identity.senderId, true, "team", "second-source"),
                  owner.cfg,
                  sourceOptions,
                )
              : undefined;
            // Both records came from the same real producer, with distinct monitor custody.
            expect(source.queued.messageId).toBe("first-source");
            if (second) {
              expect(second.queued.messageId).toBe("second-source");
              expect(getCommandOwnerAuthority(source.queued.run)?.isCurrent()).toBe(true);
              expect(getCommandOwnerAuthority(second.queued.run)?.isCurrent()).toBe(true);
            }
            const seed = async (name: string, jobSession: string) =>
              await store.service.add(
                {
                  name,
                  agentId: "main",
                  enabled: true,
                  schedule: { kind: "every", everyMs: 60_000 },
                  sessionTarget: "isolated",
                  wakeMode: "next-heartbeat",
                  payload: {
                    kind: "agentTurn",
                    message: "synthetic management target",
                    toolsAllow: ["read"],
                  },
                  delivery: { mode: "none" },
                  owner: { agentId: "main", sessionKey: jobSession, accountId: "team" },
                },
                {
                  scheduledToolPolicy: {
                    version: 1,
                    mode: "account",
                    ownerSessionKey: jobSession,
                    ownerAccountId: "team",
                  },
                },
              );
            const own = await seed("own before", sessionKey);
            const foreign = await seed("foreign before", "agent:main:slack:channel:other-owner");
            const before = await store.read();
            store.events.length = 0;
            const turn = createFollowupTurnTestTurn({
              runId: `queued-final-effect-${kind}`,
              queued: source.queued,
              config: owner.cfg,
              session: {
                kind: "session",
                key: sessionKey,
                current: () => ({ sessionId: source.queued.run.sessionId, updatedAt: 1 }),
                publish: () => undefined,
                adopt: () => undefined,
              },
              operation: {
                ...createFollowupTurnTestTurn().operation,
                abortSignal: cancelled.signal,
              },
            });
            const revokes =
              kind === "revoke-after-bind" ||
              kind === "cancel-after-bind" ||
              kind === "collected-first-source-retired";
            if (revokes) {
              store.hold(async () => {
                reached.resolve();
                await release.promise;
              });
            }
            execution.execute.mockImplementationOnce(async (params: AgentTurnParams) => {
              await withModelSelectedAutomation(params, owner, async (tool) => {
                const list = await tool.execute("global-list", {
                  action: "list",
                  includeDisabled: true,
                });
                expect(list.details).toMatchObject({
                  jobs: expect.arrayContaining([expect.objectContaining({ id: own.id })]),
                });
                const listed = list.details as { jobs: Array<{ id: string }> };
                expect(listed.jobs.some((job) => job.id === foreign.id)).toBe(isOwner);
                const update = () =>
                  tool.execute(
                    "foreign-update",
                    {
                      action: "update",
                      jobId: foreign.id,
                      job: {
                        name: "authorized foreign change",
                        enabled: false,
                        delivery: { mode: "none" },
                      },
                    },
                    cancelled.signal,
                  );
                if (!isOwner) {
                  await expect(update()).rejects.toThrow(/Automation not found:/);
                  // A restricted caller still has a working path to its own durable target.
                  await tool.execute("own-update", {
                    action: "update",
                    jobId: own.id,
                    job: { name: "own allowed change" },
                  });
                } else {
                  await update();
                }
              });
              return {
                runId: turn.runId,
                outcome: { kind: "rejected", payload: { text: "synthetic model completed" } },
              };
            });
            const queuedExecution = harness.collectQueuedInputs(
              second ? [source.queued, second.queued] : [turn.queued],
              1,
              undefined,
              async (queued) => {
                turn.queued = queued;
                await harness.execute(turn);
              },
            );
            pending = queuedExecution;
            void queuedExecution.catch(() => undefined);
            if (revokes) {
              try {
                await withinTest(
                  awaitGateBeforeSettlement(
                    reached.promise,
                    queuedExecution,
                    "mutation settled before reaching real Cron validation",
                  ),
                  test.signal,
                );
                expect(await store.read()).toEqual(before);
                if (kind === "revoke-after-bind") {
                  await owner.activatePolicy({
                    roles: {
                      default: "member",
                      definitions: {
                        admin: { scopes: [], agents: "*", sessions: { others: "none" } },
                      },
                    },
                  });
                } else if (kind === "cancel-after-bind") {
                  cancelled.abort(new Error("synthetic queued turn cancelled after tool binding"));
                } else {
                  expect(getCommandOwnerAuthority(source.queued.run)?.isCurrent()).toBe(true);
                  expect(
                    getCommandOwnerAuthority(
                      expectDefined(second, "collected second source").queued.run,
                    )?.isCurrent(),
                  ).toBe(true);
                  owner.retire();
                  expect(getCommandOwnerAuthority(source.queued.run)?.isCurrent()).toBe(false);
                  expect(
                    getCommandOwnerAuthority(
                      expectDefined(second, "collected second source").queued.run,
                    )?.isCurrent(),
                  ).toBe(true);
                }
              } finally {
                release.resolve();
              }
              await expect(queuedExecution).rejects.toThrow(/authority|grant|cancel|abort/i);
            } else {
              await queuedExecution;
            }
            await store.settle();
            const after = await store.read();
            const foreignAfter = expectDefined(
              after.find((job) => job.id === foreign.id),
              "foreign row",
            );
            const foreignBefore = expectDefined(
              before.find((job) => job.id === foreign.id),
              "original foreign row",
            );
            expect(store.entered).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  method: "cron.update",
                  params: expect.objectContaining({ id: foreign.id }),
                  runId: turn.runId,
                  management: isOwner,
                }),
              ]),
            );
            const foreignEffects = store.events.filter(
              (event) => event.jobId === foreign.id && event.action === "updated",
            );
            expect(foreignEffects).toHaveLength(kind === "owner" ? 1 : 0);
            if (kind === "owner") {
              expect(foreignAfter).toMatchObject({
                name: "authorized foreign change",
                enabled: false,
                owner: foreignBefore.owner,
              });
            } else {
              expect(foreignAfter).toEqual(foreignBefore);
            }
            if (revokes) {
              expect(after).toEqual(before);
            }
            const expected = structuredClone(after);
            store.service.stop();
            expect((await loadCronStore(owner.state.statePath("cron", "jobs.json"))).jobs).toEqual(
              expected,
            );
          } finally {
            release.resolve();
            await pending?.catch(() => undefined);
            await store.close();
          }
        },
        "role",
        "slack",
      );
    });
  });
}
