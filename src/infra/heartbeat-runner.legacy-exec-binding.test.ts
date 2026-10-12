import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { createMessageTool } from "../agents/tools/message-tool-execution.js";
import { withFullRuntimeReplyConfig } from "../auto-reply/reply/get-reply-fast-path.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../config/config.js";
import { NodeRegistry } from "../gateway/node-registry.js";
import { makeClient, registerNodeSession } from "../gateway/node-registry.test-helpers.js";
import type { NodeEventContext } from "../gateway/server-node-events-types.js";
import { handleNodeEvent } from "../gateway/server-node-events.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { buildConversationRef, normalizeConversationPeerId } from "../routing/conversation-ref.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  heartbeatTestConfig,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { requestHeartbeatAndWait, setHeartbeatWakeHandler } from "./heartbeat-wake.js";
import { runMessageAction } from "./outbound/message-action-runner.js";
import { resetSystemEventsForTest } from "./system-events.js";

// Only the paid model boundary is scripted. Conversation selection, metadata,
// exec authority, queue, reply pipeline, message tool, action runner and finalizer are real.
vi.mock("../agents/embedded-agent.js", async (original) => ({
  ...(await original<typeof import("../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(),
}));
const grammar = await loadBundledPluginFacade<
  NonNullable<typeof heartbeatRunnerTelegramPlugin.messaging>
>({
  pluginId: "telegram",
  artifactBasename: "session-key-api.ts",
});
const { telegramOutbound, normalizeTelegramMessagingTarget, looksLikeTelegramTargetId } =
  await loadBundledPluginFacade<{
    telegramOutbound: ChannelOutboundAdapter;
    normalizeTelegramMessagingTarget: (raw: string) => string | undefined;
    looksLikeTelegramTargetId: (raw: string) => boolean;
  }>({
    pluginId: "telegram",
    artifactBasename: "api.ts",
  });
const forumSource = {
  channel: "telegram",
  to: "telegram:-100123456789:topic:42",
  accountId: "work",
  threadId: "42",
};
const ownerDm = "123456789";
const marker = "OC160675-SYNTHETIC-LEGACY";

beforeEach(() => {
  resetSystemEventsForTest();
  const plugin: ChannelPlugin = {
    ...heartbeatRunnerTelegramPlugin,
    config: {
      ...heartbeatRunnerTelegramPlugin.config,
      listAccountIds: () => ["work", "personal"],
      resolveAllowFrom: ({ cfg }) => cfg.channels?.telegram?.allowFrom ?? [],
      resolveAccount: (_cfg, accountId) => ({ accountId, enabled: true, configured: true }),
    },
    outbound: telegramOutbound,
    messaging: {
      ...heartbeatRunnerTelegramPlugin.messaging,
      ...grammar,
      normalizeTarget: normalizeTelegramMessagingTarget,
      targetResolver: { looksLikeId: looksLikeTelegramTargetId },
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]));
});
afterEach(async () => {
  setHeartbeatWakeHandler(async () => ({ status: "ran", durationMs: 0 }));
  await requestHeartbeatAndWait({
    source: "manual",
    intent: "immediate",
    reason: "wake",
    coalesceMs: 0,
  });
  setHeartbeatWakeHandler(null);
  resetSystemEventsForTest();
  clearRuntimeConfigSnapshot();
  vi.clearAllMocks();
});

it.each([
  { name: "forum source", source: forumSource, explicitDm: false },
  { name: "shared group session", source: forumSource, explicitDm: false },
  { name: "reject session chat substitution", source: forumSource, explicitDm: false },
  {
    name: "reject session chat substitution for bare direct source",
    source: { ...forumSource, to: "telegram:987654321", threadId: undefined },
    explicitDm: false,
  },
  { name: "reject session thread substitution", source: forumSource, explicitDm: false },
  { name: "reject asynchronous target exception", source: forumSource, explicitDm: false },
  { name: "reject asynchronous target rejection", source: forumSource, explicitDm: false },
  { name: "reject asynchronous session exception", source: forumSource, explicitDm: false },
  {
    name: "direct source",
    source: { ...forumSource, to: "telegram:987654321", threadId: undefined },
    explicitDm: false,
  },
  { name: "explicitly requested DM work", source: forumSource, explicitDm: true },
])(
  "binds $name before tool execution and failed-send finalization",
  async ({ name, source, explicitDm }) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = withFullRuntimeReplyConfig(
        heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath),
      );
      cfg.agents!.defaults!.skipBootstrap = true;
      cfg.agents!.defaults!.model = { primary: "mock-openai/gpt-5.6-luna" };
      cfg.agents!.defaults!.models = {
        "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } },
      };
      cfg.agents!.defaults!.heartbeat = {
        every: "5m",
        target: "telegram",
        to: ownerDm,
        accountId: "personal",
      };
      cfg.commands = { ownerAllowFrom: ["telegram:" + ownerDm] };
      cfg.channels!.telegram!.allowFrom = [ownerDm];
      cfg.plugins = { enabled: false };
      setRuntimeConfigSnapshot(cfg);
      const denial = name.startsWith("reject ");
      if (denial) {
        const base = getChannelPlugin("telegram");
        if (!base) {
          throw new Error("Missing fixture channel");
        }
        const messaging: NonNullable<ChannelPlugin["messaging"]> = { ...base.messaging };
        const plugin: ChannelPlugin = { ...base, messaging };
        if (name.includes("session chat") || name.includes("session thread")) {
          messaging.resolveOutboundSessionRoute = async () => ({
            sessionKey: "agent:main:main",
            baseSessionKey: "agent:main:main",
            peer: { kind: "group", id: "-100123456789" },
            chatType: "group",
            from: "telegram:group:-100123456789",
            to: name.includes("session chat") ? ownerDm : source.to,
            threadId: name.includes("session thread") ? 99 : source.threadId,
          });
        } else if (name.includes("target exception")) {
          messaging.targetResolver = {
            looksLikeId: () => {
              throw new Error("target validation failed");
            },
          };
        } else if (name.includes("target rejection")) {
          messaging.targetResolver = { looksLikeId: () => false };
          plugin.directory = {
            listGroups: async () => [
              { kind: "group", id: "-100123456789:topic:42", name: "first" },
              { kind: "group", id: "-100123456789:topic:42", name: "second" },
            ],
          };
        } else {
          messaging.resolveOutboundSessionRoute = async () => {
            throw new Error("session validation failed");
          };
        }
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]),
        );
      }
      const runId = "legacy-" + name;
      const sessionKey =
        name === "shared group session"
          ? "agent:main:telegram:group:-100123456789"
          : "agent:main:main"; // A shared model session is not a transport address.
      await seedSessionStore(storePath, sessionKey, {
        sessionId: "legacy-origin",
        chatType: "direct",
        lastChannel: "telegram",
        lastTo: ownerDm,
        lastAccountId: "personal",
      });
      const registry = new NodeRegistry();
      const frames: string[] = [];
      registerNodeSession(
        registry,
        makeClient("legacy-conn", "legacy-node", frames, {
          version: "2026.9.4",
          platform: "linux",
          commands: ["system.run"],
        }),
        {},
      );
      try {
        const invocation = registry.invoke({
          nodeId: "legacy-node",
          command: "system.run",
          timeoutMs: 0,
          params: { runId, sessionKey },
          turnSource: source,
        });
        const request = JSON.parse(frames[0]!).payload;
        registry.handleInvokeResult({
          id: request.id,
          nodeId: "legacy-node",
          connId: "legacy-conn",
          ok: true,
          payloadJSON: JSON.stringify({ exitCode: 0, stdout: marker, durationMs: 267 }),
        });
        await invocation;
        const unexpected = () => {
          throw new Error("Unexpected non-exec node event effect");
        };
        const ctx: NodeEventContext = {
          deps: {},
          broadcast: unexpected,
          nodeSendToSession: unexpected,
          nodeSubscribe: unexpected,
          nodeUnsubscribe: unexpected,
          broadcastVoiceWakeChanged: unexpected,
          addChatRun: unexpected,
          removeChatRun: unexpected,
          chatAbortControllers: new Map(),
          dedupe: new Map(),
          agentRunSeq: new Map(),
          getHealthCache: () => null,
          refreshHealthSnapshot: async () => unexpected(),
          loadGatewayModelCatalog: async () => [],
          authorizeNodeSystemRunEvent: (p) =>
            registry.authorizeSystemRunEventWithState({
              ...p,
              terminal: p.event !== "exec.started",
            }) ?? false,
          logGateway: { warn: vi.fn() },
        };
        // Historical node envelope: no suppression flag, result-first flag or route hints.
        await handleNodeEvent(
          ctx,
          "legacy-node",
          {
            event: "exec.finished",
            payloadJSON: JSON.stringify({
              sessionKey,
              runId,
              exitCode: 0,
              output: marker,
            }),
          },
          { connId: "legacy-conn" },
        );
        const attempts: Array<{ to: string; text: string; accountId?: string; thread?: unknown }> =
          [];
        const send = vi.fn(async (to: string, text: string, opts?: Record<string, unknown>) => {
          attempts.push({
            to,
            text,
            accountId: opts?.accountId as string | undefined,
            thread: opts?.messageThreadId,
          });
          if (text.includes(marker)) {
            throw new Error("Telegram 400: message thread not found");
          }
          return { messageId: "status-receipt", chatId: to };
        });
        const originalConversationRef = buildConversationRef({
          channel: source.channel,
          accountId: source.accountId,
          kind: source.threadId ? "group" : "direct",
          peerId: normalizeConversationPeerId(source.channel, source.to),
          threadId: source.threadId,
        });
        let persistedTransport: unknown;
        let modelRoute: unknown;
        let selectedTarget: string | undefined;
        let toolReceipt: unknown;
        const privateInputs: string[] = [];
        vi.mocked(runEmbeddedAgent).mockImplementation(async (params) => {
          if (denial) {
            privateInputs.push(
              params.prompt,
              JSON.stringify(params.userTurnTranscriptRecorder?.message) ?? "",
            );
            return { payloads: [{ text: "HEARTBEAT_OK" }], meta: { durationMs: 1 } };
          }
          await params.userTurnTranscriptRecorder?.persistApproved();
          expect(params.userTurnTranscriptRecorder?.hasPersisted()).toBe(true);
          persistedTransport = params.userTurnTranscriptRecorder?.getPersistedMessage?.();
          modelRoute = {
            to: params.messageTo,
            accountId: params.agentAccountId,
            threadId: params.messageThreadId,
            chatType: params.chatType,
          };
          const tool = createMessageTool({
            config: cfg,
            agentId: params.agentId,
            agentSessionKey: params.sessionKey,
            agentAccountId: params.agentAccountId,
            currentChannelProvider: params.messageChannel,
            currentChannelId: params.currentChannelId,
            currentMessagingTarget: params.currentMessagingTarget,
            currentThreadTs: params.currentThreadTs,
            runMessageAction: (input) =>
              runMessageAction({
                ...input,
                gateway: undefined,
                forceCoreDelivery: true,
                deps: { telegram: send },
              }),
          });
          // Model chooses the conversation supplied by the production turn, not a test-fixed recipient.
          selectedTarget = explicitDm
            ? ownerDm
            : (params.currentMessagingTarget ?? params.messageTo);
          try {
            toolReceipt = await tool.execute("completion-send", {
              action: "send",
              target: selectedTarget,
              message: marker,
              final: true,
            });
          } catch (error) {
            toolReceipt = { error: error instanceof Error ? error.message : String(error) };
          }
          return {
            payloads: [
              {
                text: `Delivery is unconfirmed: ${JSON.stringify(toolReceipt)}. No resend attempted.`,
              },
            ],
            meta: { durationMs: 1 },
          };
        });
        const result = await runHeartbeatOnce({
          cfg,
          agentId: "main",
          sessionKey,
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          deps: { getReplyFromConfig, telegram: send },
        });
        if (denial) {
          expect(privateInputs.every((input) => !input.includes(marker))).toBe(true);
          expect(attempts).toEqual([]);
          return;
        }
        expect(result.status).toBe("ran");
        expect(runEmbeddedAgent).toHaveBeenCalledOnce();
        expect(modelRoute).toMatchObject({
          to: source.to,
          accountId: "work",
          threadId: source.threadId,
          chatType: source.threadId ? "group" : "direct",
        });
        expect(persistedTransport).toMatchObject({
          provenance: { kind: "internal_system", sourceTool: "exec" },
          __openclaw: {
            transport: {
              channel: "telegram",
              conversationRef: originalConversationRef,
              ...(source.threadId ? { threadId: source.threadId } : {}),
            },
          },
        });
        if (explicitDm) {
          expect(selectedTarget).toBe(ownerDm);
        } else {
          expect(selectedTarget).not.toBe(ownerDm);
        }
        expect(toolReceipt).toMatchObject({ error: "Telegram 400: message thread not found" });
        expect(attempts).toHaveLength(2);
        expect(attempts[0]?.text).toContain(marker);
        expect(normalizeTelegramMessagingTarget(attempts[0]?.to ?? "")).toBe(
          explicitDm ? "telegram:" + ownerDm : source.to,
        );
        expect(attempts[1]).toMatchObject({
          accountId: "work",
          thread: source.threadId ? 42 : undefined,
        });
        expect(normalizeTelegramMessagingTarget(attempts[1]?.to ?? "")).toBe(source.to);
        expect(attempts[1]?.text).toContain("Telegram 400: message thread not found");
        expect(attempts[1]?.text).toContain("No resend attempted");
      } finally {
        registry.unregister("legacy-conn");
      }
    });
  },
);
