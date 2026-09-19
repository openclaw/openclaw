import { setTimeout as sleep } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { settleRequesterTurnAfterSessionSpawns } from "../agents/subagents/registry/subagent-registry-requester-yield.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { ProgressContinuationReceipt } from "../channels/progress-continuation.js";
import { createChannelProgressDraftCompositor } from "../channels/progress-draft-compositor.js";
import type { ChannelProgressDraftCompositorSnapshot } from "../channels/progress-draft-compositor.types.js";
import type { OpenClawConfig } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  beginConversationDeliveryOperation,
  getConversationDeliveryOperation,
  markConversationDeliverySent,
  markConversationDeliveryUnknown,
} from "../config/sessions/conversation-delivery-store.js";
import { buildConversationIdentity } from "../config/sessions/conversation-identity.js";
import {
  resolveConversationRegistryScope,
  resolveCurrentConversationSession,
  runConversationDatabaseWrite,
  type PreparedConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import {
  replaceSessionEntry,
  updateSessionLastRoute,
} from "../config/sessions/session-accessor.js";
import { sendMessage } from "../infra/outbound/message.js";
import { captureStateDatabaseCoordinatorRuntime } from "../infra/state-database-coordinator.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { holdStateDatabaseCoordinator } from "../test-utils/state-database-contention.js";
import {
  createSubagentTaskBackingDetail,
  resolveManagedTaskBackingDetail,
} from "./task-backing-authority.js";
import { createManagedTaskFlow, createTaskFlowForTask } from "./task-flow-registry.js";
import {
  adoptTaskProgressMessage,
  publishTaskProgressMessage,
  readTaskProgressSnapshot,
  type TaskProgressPublication,
} from "./task-registry-progress-runtime.js";
import { flushTaskProgressBatch, getTaskProgressBatchesForRuns } from "./task-registry-progress.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { linkTaskToFlowById } from "./task-registry-record-api.js";
import { taskProgressBatches } from "./task-registry-state.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

const channel = "progresschat";
const sessionKey = "agent:main:progresschat:direct:operator:thread:topic-a";
const requesterSessionId = "requester-window-1";
const operationId = "detached-progress-1";
const origin = { channel, accountId: "default", to: "user:operator", threadId: "topic-a" };
const initialContent = "Research: reading sources";
const updatedContent = "Research: comparing findings";
const initialSnapshot: ChannelProgressDraftCompositorSnapshot = {
  lines: ["Read primary sources"],
  label: "Research",
  plan: [{ step: "Compare findings", status: "in_progress" }],
};

type PlatformMessage = {
  messageId: string;
  accountId: string;
  to: string;
  threadId: string | undefined;
  text: string;
};
const initialMessage: PlatformMessage = {
  messageId: "platform-card-1",
  accountId: "default",
  to: "user:operator",
  threadId: "topic-a",
  text: initialContent,
};

type PublisherFixture = {
  cfg: OpenClawConfig;
  scope: PreparedConversationRegistryScope;
  messages: Map<string, PlatformMessage>;
  sends: PlatformMessage[];
  edits: PlatformMessage[];
  bindAudience: (audience?: typeof origin, sessionId?: string) => Promise<string>;
  replaceRequester: () => Promise<void>;
  replaceConversation: () => Promise<void>;
  addSiblingAssociation: () => Promise<void>;
  disableAccount: () => void;
  beforeRoute: (prepare: () => Promise<void>) => void;
  beforeEdit: (prepare: () => Promise<void>) => void;
  restart: () => Promise<void>;
  adopt: (
    receipt?: Partial<ProgressContinuationReceipt>,
    overrides?: Partial<Omit<TaskProgressPublication, "content" | "snapshot">>,
  ) => Promise<boolean>;
  readSnapshot: (
    overrides?: Partial<
      Pick<TaskProgressPublication, "operationId" | "agentId" | "sessionKey" | "requesterSessionId">
    >,
  ) => ChannelProgressDraftCompositorSnapshot | undefined;
  publish: (
    content?: string,
    overrides?: Partial<TaskProgressPublication>,
  ) => Promise<"sent" | "unchanged" | "suppressed" | "unknown" | "unsupported">;
  recordUncertainAttempt: (status: "created" | "unknown" | "unidentified-sent") => Promise<void>;
  installModifier: (hookName: "message_sending" | "reply_payload_sending") => void;
};

async function withPublisher(run: (fixture: PublisherFixture) => Promise<void>) {
  await withOpenClawTestState({ label: "task-progress-receipts" }, async (state) => {
    try {
      await run(await createPublisher(state.stateDir, state.workspaceDir));
    } finally {
      resetGlobalHookRunner();
      resetPluginRuntimeStateForTest();
    }
  });
}

async function createPublisher(stateDir: string, workspaceDir: string): Promise<PublisherFixture> {
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: workspaceDir } },
    session: { dmScope: "per-channel-peer" },
    channels: { [channel]: { enabled: true } },
  };
  setRuntimeConfigSnapshot(cfg);
  // The original card already exists remotely; reopening local storage cannot erase it.
  const messages = new Map<string, PlatformMessage>([[initialMessage.messageId, initialMessage]]);
  const sends: PlatformMessage[] = [];
  const edits: PlatformMessage[] = [];
  let beforeRoute: (() => Promise<void>) | undefined;
  let beforeEdit: (() => Promise<void>) | undefined;
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: channel,
      capabilities: { chatTypes: ["direct"], threads: true },
      config: { listAccountIds: () => ["default", "secondary"] },
    }),
    messaging: {
      normalizeTarget: (target) => target.replace(/^progresschat:/u, "").trim(),
      targetResolver: { looksLikeId: (target) => target.startsWith("user:") },
      resolveOutboundSessionRoute: async ({ agentId, target, threadId }) => {
        await beforeRoute?.();
        const to = target.replace(/^progresschat:/u, "");
        const peerId = to.replace(/^user:/u, "");
        const baseSessionKey = `agent:${agentId}:${channel}:direct:${peerId}`;
        return {
          sessionKey: threadId ? `${baseSessionKey}:thread:${threadId}` : baseSessionKey,
          baseSessionKey,
          peer: { kind: "direct", id: peerId },
          chatType: "direct",
          from: `${channel}:${peerId}`,
          to: threadId === undefined ? to : `${to}:topic:${threadId}`,
          threadId: threadId ?? undefined,
        };
      },
    },
    outbound: {
      deliveryMode: "direct",
      sendText: async (ctx) => {
        ctx.signal?.throwIfAborted();
        await ctx.onPlatformSendDispatch?.();
        ctx.assertDirectAdapterHandoff?.();
        const message: PlatformMessage = {
          messageId: `replacement-card-${sends.length + 1}`,
          accountId: ctx.accountId ?? "default",
          to: ctx.to,
          threadId: ctx.threadId == null ? undefined : String(ctx.threadId),
          text: ctx.text,
        };
        sends.push(message);
        messages.set(message.messageId, message);
        return { channel, messageId: message.messageId };
      },
    },
    actions: {
      describeMessageTool: () => ({ actions: ["edit"] }),
      writeAuthorityActions: ["edit"],
      handleAction: async (ctx) => {
        await beforeEdit?.();
        ctx.assertDirectAdapterHandoff?.();
        const message = messages.get(String(ctx.params.messageId));
        if (
          ctx.action !== "edit" ||
          !message ||
          message.accountId !== ctx.accountId ||
          message.to !== String(ctx.params.to).split(":topic:")[0] ||
          message.threadId !== ctx.params.threadId ||
          typeof ctx.params.message !== "string"
        ) {
          throw new Error("No platform message exists at the requested address");
        }
        const edited = { ...message, text: ctx.params.message };
        messages.set(message.messageId, edited);
        edits.push(edited);
        return {
          content: [{ type: "text", text: "Message edited" }],
          details: { ok: true, messageId: message.messageId },
        };
      },
    },
  };
  const registry = createTestRegistry([
    { pluginId: channel, plugin, source: "test", origin: "bundled" },
  ]);
  registry.plugins.push(createPluginRecord({ id: channel, origin: "bundled" }));
  setActivePluginRegistry(registry);
  initializeGlobalHookRunner(registry);
  const scope = resolveConversationRegistryScope({ agentId: "main", config: cfg });

  async function bindAudience(
    audience = origin,
    sessionId = requesterSessionId,
    boundSessionKey = sessionKey,
  ) {
    await updateSessionLastRoute({
      storePath: scope.storePath,
      sessionKey: boundSessionKey,
      channel,
      accountId: audience.accountId,
      to: audience.to,
      threadId: audience.threadId,
      ctx: {
        Provider: channel,
        Surface: channel,
        ChatType: "direct",
        From: `${channel}:${audience.to.replace(/^user:/u, "")}`,
        To: audience.to,
        AccountId: audience.accountId,
        MessageThreadId: audience.threadId,
        NativeDirectUserId: audience.to.replace(/^user:/u, ""),
      },
    });
    const identity = buildConversationIdentity({
      channel,
      accountId: audience.accountId,
      kind: "direct",
      peerId: audience.to,
      deliveryTarget: audience.to,
      threadId: audience.threadId,
    });
    if (!identity) {
      throw new Error("Synthetic conversation identity is missing");
    }
    expect(resolveCurrentConversationSession(scope, identity.conversationRef)).toEqual({
      sessionKey: boundSessionKey,
      sessionId,
    });
    return identity.conversationRef;
  }

  async function replaceRequester() {
    await replaceSessionEntry(
      { ...scope, sessionKey },
      { sessionId: "requester-window-2", updatedAt: 2 },
    );
    await bindAudience(origin, "requester-window-2");
  }

  await replaceSessionEntry(
    { ...scope, sessionKey },
    { sessionId: requesterSessionId, updatedAt: 1 },
  );
  const conversationRef = await bindAudience();
  return {
    cfg,
    scope,
    messages,
    sends,
    edits,
    bindAudience,
    replaceRequester,
    addSiblingAssociation: async () => {
      const replacementKey = "agent:main:progresschat:direct:replacement";
      await replaceSessionEntry(
        { ...scope, sessionKey: replacementKey },
        { sessionId: "replacement-window", updatedAt: 2 },
      );
      await bindAudience(origin, "replacement-window", replacementKey);
    },
    replaceConversation: async () => {
      await bindAudience({ ...origin, to: "user:another-recipient" });
    },
    disableAccount: () => {
      setRuntimeConfigSnapshot({ ...cfg, channels: { [channel]: { enabled: false } } });
    },
    beforeRoute: (prepare) => {
      beforeRoute = prepare;
    },
    beforeEdit: (prepare) => {
      beforeEdit = prepare;
    },
    restart: () => cleanupSessionStateForTest({ stateDir }),
    adopt: (receipt = {}, overrides = {}) =>
      adoptTaskProgressMessage({
        operationId,
        requesterSessionId,
        sessionKey,
        agentId: "main",
        origin,
        signal: new AbortController().signal,
        assertCurrent: () => {},
        receipt: {
          ...origin,
          messageId: initialMessage.messageId,
          text: initialContent,
          snapshot: initialSnapshot,
          ...receipt,
        },
        ...overrides,
      }),
    readSnapshot: (overrides = {}) =>
      readTaskProgressSnapshot({
        operationId,
        requesterSessionId,
        sessionKey,
        agentId: "main",
        ...overrides,
      }),
    publish: (content = initialContent, overrides = {}) =>
      publishTaskProgressMessage({
        operationId,
        requesterSessionId,
        sessionKey,
        agentId: "main",
        origin,
        content,
        snapshot: initialSnapshot,
        signal: new AbortController().signal,
        assertCurrent: () => {},
        ...overrides,
      }),
    recordUncertainAttempt: (status) =>
      runConversationDatabaseWrite(scope, (writeScope) => {
        beginConversationDeliveryOperation(writeScope, {
          operationId,
          operationKind: "send",
          conversationRef,
          sourceSessionKey: sessionKey,
          message: initialContent,
        });
        if (status === "unknown") {
          markConversationDeliveryUnknown(writeScope, operationId);
        } else if (status === "unidentified-sent") {
          markConversationDeliverySent(writeScope, operationId);
        }
      }),
    installModifier: (hookName) => {
      registry.typedHooks.push({
        pluginId: channel,
        hookName,
        handler: () => ({ cancel: true }),
        source: "test",
      });
    },
  };
}

it("keeps the captured requester when a child also owns a current association on the address", async () => {
  await withPublisher(async (fixture) => {
    await fixture.addSiblingAssociation();
    expect(await fixture.adopt()).toBe(true);
    await fixture.restart();
    expect(fixture.readSnapshot()?.plan).toEqual(initialSnapshot.plan);
    expect(await fixture.publish(updatedContent)).toBe("sent");
    expect(fixture.sends).toEqual([]);
    expect([...fixture.messages.values()]).toEqual([{ ...initialMessage, text: updatedContent }]);
  });
});

describe("detached progress at the registered channel boundary", () => {
  it.each(["warm", "reopened"] as const)(
    "keeps adopted-card publication responsive while shared-state admission is held (%s)",
    async (stateMode) => {
      await withPublisher(async (fixture) => {
        // Session seeding schedules maintenance that must settle before introducing contention.
        await fixture.restart();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        const entry: SubagentRunRecord = {
          runId: "contended-card-child",
          childSessionKey: "agent:main:subagent:contended-card",
          requesterSessionKey: sessionKey,
          requesterAgentId: "main",
          requesterDisplayKey: "card requester",
          requesterTurnRunId: "contended-card-requester-turn",
          requesterTurnYielded: true,
          completionRequesterSessionId: requesterSessionId,
          task: "Continue the adopted card",
          cleanup: "keep",
          createdAt: Date.now(),
          generation: 1,
          execution: { status: "running", startedAt: Date.now() },
          expectsCompletionMessage: true,
        };
        subagentRuns.set(entry.runId, entry);
        let holder: ReturnType<typeof holdStateDatabaseCoordinator> | undefined;
        let publication: Promise<void> | undefined;
        const failures: unknown[] = [];
        try {
          const params = {
            runId: entry.runId,
            childSessionKey: entry.childSessionKey,
            ownerKey: sessionKey,
            requesterAgentId: "main",
            task: entry.task,
            notifyPolicy: "state_changes" as const,
            requesterOrigin: origin,
          };
          const canonical = createTaskFixture("subagent", {
            ...params,
            detail: createSubagentTaskBackingDetail(1),
          });
          const mirrored = expectDefined(
            createTaskFlowForTask({ task: canonical }),
            "canonical child flow",
          );
          expect(
            linkTaskToFlowById({ taskId: canonical.taskId, flowId: mirrored.flowId }),
          ).not.toBeNull();
          const flow = expectDefined(
            createManagedTaskFlow({
              ownerKey: sessionKey,
              controllerId: "tests/contended-progress",
              goal: entry.task,
              requesterOrigin: origin,
            }),
            "managed progress flow",
          );
          createTaskFixture("subagent", {
            ...params,
            parentFlowId: flow.flowId,
            detail: resolveManagedTaskBackingDetail({
              ...params,
              runtime: "subagent",
              scopeKind: "session",
            }),
          });
          expect(await fixture.adopt()).toBe(true);
          await prepareTaskRegistryRead();
          const sharedState = openOpenClawStateDatabase();
          expect(taskProgressBatches.size).toBe(0);
          if (stateMode === "reopened") {
            await closeOpenClawStateDatabaseByPathAsync(sharedState.path);
          }
          holder = holdStateDatabaseCoordinator(
            sharedState.path,
            captureStateDatabaseCoordinatorRuntime(),
            300,
          );
          await holder.ready;
          const released = holder.released;
          const timer = sleep(10).then(() => Atomics.load(released, 0));
          expect(
            settleRequesterTurnAfterSessionSpawns({
              requesterSessionKey: sessionKey,
              requesterAgentId: "main",
              requesterTurnRunId: "contended-card-requester-turn",
              requesterYielded: true,
              acceptedSessionSpawns: [
                {
                  runId: entry.runId,
                  childSessionKey: entry.childSessionKey,
                  expectsCompletionMessage: true,
                },
              ],
              progressPresentation: { operationId },
              runs: subagentRuns,
              persistOrThrow: () => {},
              schedule: () => {},
            }),
          ).toBe(true);
          const selected = expectDefined(
            (await getTaskProgressBatchesForRuns([entry])).find(
              ({ batch }) => batch.operationId === operationId,
            ),
            "adopted progress batch",
          );
          publication = flushTaskProgressBatch(selected.key, selected.batch);
          const releasedAtTimer = await timer;
          await publication;
          expect(fixture.sends).toEqual([]);
          expect(fixture.edits).toHaveLength(1);
          expect(fixture.edits[0]?.messageId).toBe(initialMessage.messageId);
          expect(getActiveGatewayRootWorkCount()).toBe(0);
          expect(releasedAtTimer, "timer must run before the contended coordinator releases").toBe(
            0,
          );
        } catch (error) {
          failures.push(error);
        } finally {
          for (const cleanup of [
            () => holder?.release(),
            () => holder?.joined,
            () => publication,
            () => closeOpenClawStateDatabaseAsync(),
            () => resetTaskRegistryForTests({ persist: false }),
            () => resetTaskFlowRegistryForTests({ persist: false }),
            () => subagentRuns.delete(entry.runId),
          ]) {
            try {
              await cleanup();
            } catch (error) {
              if (!failures.includes(error)) {
                failures.push(error);
              }
            }
          }
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            "Adopted progress fixture failed with cleanup errors",
            {
              cause: failures[0],
            },
          );
        }
      });
    },
  );

  it("restores prior presentation into subsequent updates across two storage reopens", async () => {
    await withPublisher(async (fixture) => {
      expect(await fixture.adopt()).toBe(true);
      expect(fixture.sends).toEqual([]);
      expect(fixture.edits).toEqual([]);
      expect([...fixture.messages.values()]).toEqual([initialMessage]);
      for (const line of ["Compare independent findings", "Finish source audit"]) {
        await fixture.restart();
        const progress = createChannelProgressDraftCompositor({
          entry: { streaming: { progress: { toolProgress: true } } },
          mode: "progress",
          active: true,
          seed: "research",
          initialSnapshot: fixture.readSnapshot(),
          update: async (text, options) =>
            (await fixture.publish(text, { snapshot: options.snapshot })) === "sent",
        });
        try {
          expect(await progress.pushToolProgress(line, { startImmediately: true })).toBe(true);
        } finally {
          progress.markFinalReplyStarted();
        }
      }
      expect(fixture.sends).toEqual([]);
      expect([...fixture.messages.keys()]).toEqual([initialMessage.messageId]);
      const visible = fixture.messages.get(initialMessage.messageId)?.text;
      expect(visible).toContain("Read primary sources");
      expect(visible).toContain("Compare findings");
      expect(visible).toContain("Compare independent findings");
      expect(visible).toContain("Finish source audit");
    });
  });

  it.each(["missing", "created", "unknown", "unidentified-sent"] as const)(
    "does not invent a replacement for a %s receipt",
    async (status) => {
      await withPublisher(async (fixture) => {
        if (status !== "missing") {
          await fixture.recordUncertainAttempt(status);
        }
        await fixture.restart();
        expect(await fixture.publish(updatedContent)).toBe("unknown");
        expect(fixture.sends).toEqual([]);
        expect(fixture.edits).toEqual([]);
        expect([...fixture.messages.values()]).toEqual([initialMessage]);
      });
    },
  );

  it("accepts provider-normalized targets without changing the captured audience", async () => {
    await withPublisher(async (fixture) => {
      expect(await fixture.adopt({ to: "progresschat:user:operator" })).toBe(true);
      expect(await fixture.publish(updatedContent)).toBe("sent");
      expect(fixture.sends).toEqual([]);
      expect([...fixture.messages.values()]).toEqual([{ ...initialMessage, text: updatedContent }]);
    });
  });

  it.each([
    { name: "channel", receipt: { channel: "other" } },
    { name: "account", receipt: { accountId: "secondary" } },
    { name: "recipient", receipt: { to: "user:other" } },
    { name: "thread", receipt: { threadId: "topic-b" } },
    { name: "missing thread", receipt: { threadId: undefined } },
    { name: "unidentified message", receipt: { messageId: "" } },
  ])("rejects adoption with a mismatched $name", async ({ receipt }) => {
    await withPublisher(async (fixture) => {
      expect(await fixture.adopt(receipt)).toBe(false);
      expect(await fixture.publish(updatedContent)).toBe("unknown");
      expect(fixture.sends).toEqual([]);
      expect(fixture.edits).toEqual([]);
      expect([...fixture.messages.values()]).toEqual([initialMessage]);
    });
  });

  it.each([
    { name: "account", audience: { ...origin, accountId: "secondary" } },
    { name: "recipient", audience: { ...origin, to: "user:other" } },
    { name: "thread", audience: { ...origin, threadId: "topic-b" } },
  ])("cannot reuse a persisted receipt for another $name", async ({ audience }) => {
    await withPublisher(async (fixture) => {
      expect(await fixture.adopt()).toBe(true);
      // Both routes are valid for the requester; the receipt owns the original audience.
      await fixture.bindAudience(audience);
      await fixture.restart();
      await expect(fixture.publish(updatedContent, { origin: audience })).rejects.toThrow(
        /receipt belongs to another destination/u,
      );
      expect(fixture.sends).toEqual([]);
      expect(fixture.edits).toEqual([]);
      expect([...fixture.messages.values()]).toEqual([initialMessage]);
    });
  });

  it("rechecks authority after the receipt's own asynchronous route resolution", async () => {
    await withPublisher(async (fixture) => {
      let resolutions = 0;
      fixture.beforeRoute(async () => {
        resolutions += 1;
        if (resolutions === 2) {
          fixture.disableAccount();
        }
      });
      await expect(fixture.adopt()).rejects.toThrow(/account.*available/u);
      expect(getConversationDeliveryOperation(fixture.scope, operationId)).toBeUndefined();
      expect(fixture.sends).toEqual([]);
      expect(fixture.edits).toEqual([]);
      expect([...fixture.messages.values()]).toEqual([initialMessage]);
    });
  });

  const revocations = [
    {
      name: "requester incarnation",
      revoke: async (fixture: PublisherFixture) => fixture.replaceRequester(),
      error: /requester.*replaced/u,
    },
    {
      name: "conversation binding",
      revoke: async (fixture: PublisherFixture) => fixture.replaceConversation(),
      error: /conversation.*replaced/u,
    },
    {
      name: "account",
      revoke: async (fixture: PublisherFixture) => fixture.disableAccount(),
      error: /account.*available/u,
    },
    {
      name: "modifier policy",
      revoke: async (fixture: PublisherFixture) => fixture.installModifier("message_sending"),
      error: /preview policy changed/u,
    },
  ];

  it.each(revocations)(
    "rejects adoption when $name is revoked during route resolution",
    async ({ revoke, error }) => {
      await withPublisher(async (fixture) => {
        fixture.beforeRoute(() => revoke(fixture));
        await expect(fixture.adopt()).rejects.toThrow(error);
        expect(getConversationDeliveryOperation(fixture.scope, operationId)).toBeUndefined();
        expect(fixture.sends).toEqual([]);
        expect(fixture.edits).toEqual([]);
        expect([...fixture.messages.values()]).toEqual([initialMessage]);
      });
    },
  );

  it.each(revocations)(
    "revalidates $name after asynchronous edit preparation",
    async ({ revoke, error }) => {
      await withPublisher(async (fixture) => {
        expect(await fixture.adopt()).toBe(true);
        await fixture.restart();
        fixture.beforeEdit(() => revoke(fixture));
        await expect(fixture.publish(updatedContent)).rejects.toThrow(error);
        expect(fixture.sends).toEqual([]);
        expect(fixture.edits).toEqual([]);
        expect([...fixture.messages.values()]).toEqual([initialMessage]);
      });
    },
  );

  it("does not restore cosmetic state outside its source requester window", async () => {
    await withPublisher(async (fixture) => {
      expect(await fixture.adopt()).toBe(true);
      expect(fixture.readSnapshot({ requesterSessionId: "other-window" })).toBeUndefined();
      expect(fixture.readSnapshot({ sessionKey: "agent:main:other" })).toBeUndefined();
      await fixture.replaceRequester();
      expect(fixture.readSnapshot()).toBeUndefined();
    });
  });

  it.each([
    { hookName: "message_sending", outcome: "unsupported" },
    { hookName: "reply_payload_sending", outcome: "suppressed" },
  ] as const)(
    "does not adopt under the $hookName modifier policy",
    async ({ hookName, outcome }) => {
      await withPublisher(async (fixture) => {
        fixture.installModifier(hookName);
        expect(await fixture.adopt()).toBe(false);
        expect(await fixture.publish()).toBe(outcome);
        expect(getConversationDeliveryOperation(fixture.scope, operationId)).toBeUndefined();
        expect(fixture.sends).toEqual([]);
        expect(fixture.edits).toEqual([]);
      });
    },
  );

  it("preserves message_sending cancellation on the ordinary full-message fallback", async () => {
    await withPublisher(async (fixture) => {
      fixture.installModifier("message_sending");
      expect(await fixture.adopt()).toBe(false);
      const fallback = await sendMessage({
        cfg: fixture.cfg,
        channel,
        to: origin.to,
        accountId: origin.accountId,
        threadId: origin.threadId,
        content: initialContent,
        skipQueue: true,
        gatewayOwnedDelivery: true,
      });
      expect(fallback.deliveryStatus).toBe("suppressed");
      expect(fixture.sends).toEqual([]);
      expect(fixture.edits).toEqual([]);
    });
  });

  it.each([
    { hookName: "message_sending", outcome: "unknown" },
    { hookName: "reply_payload_sending", outcome: "suppressed" },
  ] as const)(
    "does not bypass a newly installed $hookName modifier by editing or replacing a recovered card",
    async ({ hookName, outcome }) => {
      await withPublisher(async (fixture) => {
        expect(await fixture.adopt()).toBe(true);
        await fixture.restart();
        fixture.installModifier(hookName);
        expect(await fixture.publish(updatedContent)).toBe(outcome);
        expect(fixture.sends).toEqual([]);
        expect(fixture.edits).toEqual([]);
        expect([...fixture.messages.values()]).toEqual([initialMessage]);
      });
    },
  );
});
