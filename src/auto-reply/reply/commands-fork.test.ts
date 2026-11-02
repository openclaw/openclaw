import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelConversationBindingSupport } from "../../channels/plugins/types.conversation-bindings.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createGatewaySession } from "../../gateway/session-create-service.js";
import {
  getSessionBindingService,
  registerSessionBindingAdapterV2,
  testing,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../shared/transcript-only-openclaw-assistant.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildBuiltinChatCommands } from "../commands-registry.shared.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";
import { handleForkCommand } from "./commands-fork.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

const channel = "telegram";
const parentKey = "agent:main:telegram:group:room:thread:original";
const sends = vi.fn(async (_input: { text: string; to: string; threadId?: string | number }) => ({
  channel,
  messageId: "recap",
}));
const records: SessionBindingRecord[] = [];
let inspectNativeCreate: () => Promise<void> = async () => {};
let assertForkCurrent: (() => void) | undefined;
let returnedBindingPatch: Partial<SessionBindingRecord> | undefined;
let nativeCurrent: () => void = () => {};
let recapFormatter: ((text: string) => ReplyPayload) | undefined;
let audienceNotice: string | undefined;
let previousRegistry: ReturnType<typeof captureActivePluginRegistrySnapshot>;

beforeEach(() => {
  previousRegistry = captureActivePluginRegistrySnapshot();
  records.length = 0;
  inspectNativeCreate = async () => {};
  assertForkCurrent = undefined;
  returnedBindingPatch = undefined;
  nativeCurrent = () => {};
  recapFormatter = undefined;
  audienceNotice = undefined;
  sends.mockClear();
  testing.resetSessionBindingAdaptersForTests();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: channel,
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: channel,
            capabilities: { chatTypes: ["group"], threads: true },
          }),
          conversationBindings: {
            prepareFork: async (
              input: Parameters<NonNullable<ChannelConversationBindingSupport["prepareFork"]>>[0],
            ) => {
              if (!input.isGroup || !input.source.threadId) {
                return {
                  ok: false as const,
                  reason: "/fork works only inside threads, not in DMs or unthreaded chats.",
                };
              }
              return {
                ok: true as const,
                assertCurrent: () => {
                  input.assertCurrent();
                  nativeCurrent();
                },
                formatRecap: (text: string) => recapFormatter?.(text) ?? { text },
                create: async (targetSessionKey: string) => {
                  assertForkCurrent = input.assertCurrent;
                  await inspectNativeCreate();
                  input.assertCurrent();
                  const binding = await getSessionBindingService().bind({
                    targetSessionKey,
                    targetKind: "session",
                    placement: "child",
                    conversation: { channel, accountId: input.accountId, ...input.source },
                    metadata: { threadName: input.title, boundBy: input.senderId },
                    assertCurrent: input.assertCurrent,
                  });
                  return {
                    binding: { ...binding, ...returnedBindingPatch },
                    notice: audienceNotice,
                  };
                },
              };
            },
          },
          messaging: {
            resolveDeliveryTarget: ({ conversationId }: { conversationId: string }) => ({
              to: "room",
              threadId: conversationId,
            }),
          },
          outbound: { deliveryMode: "direct", sendText: sends },
        },
      },
    ]),
  );
  const resolve = (ref: { conversationId: string }) =>
    records.find((record) => record.conversation.conversationId === ref.conversationId) ?? null;
  registerSessionBindingAdapterV2({
    version: 2,
    channel,
    accountId: "default",
    capabilities: { placements: ["child"] },
    assertCurrent() {},
    listBySession: (key) => records.filter((r) => r.targetSessionKey === key),
    listBySessionAsync: async (key) => records.filter((r) => r.targetSessionKey === key),
    resolveByConversation: resolve,
    resolveByConversationAsync: async (ref) => resolve(ref),
    inspectByConversationAsync: async (ref) => resolve(ref),
    inspectByConversationsAsync: async (refs) => ({
      bindings: refs.map(resolve),
      assertCurrent() {},
    }),
    touchAsync: async () => {},
    bind: async (input) => {
      input.assertCurrent?.();
      const record: SessionBindingRecord = {
        bindingId: "fork-binding",
        targetSessionKey: input.targetSessionKey,
        targetKind: input.targetKind,
        conversation: {
          ...input.conversation,
          conversationId: "new-thread",
          parentConversationId: "room",
        },
        status: "active",
        boundAt: 1,
        metadata: input.metadata,
      };
      records.push(record);
      return record;
    },
  });
});
afterEach(() => {
  testing.resetSessionBindingAdaptersForTests();
  restoreActivePluginRegistrySnapshot(previousRegistry);
});
function params(body = "/fork Alternative") {
  const value = buildCommandTestParams(
    body,
    {},
    {
      Provider: channel,
      Surface: channel,
      ChatType: "group",
      OriginatingTo: "room",
      MessageThreadId: "original",
      SenderId: "user-1",
      From: "room",
      To: "room",
      SessionKey: parentKey,
      MessageSid: "fork-command-1",
    },
  );
  value.isGroup = true;
  value.sessionKey = parentKey;
  return value;
}

it("registers native and text /fork and rejects unsupported/unauthorized input without effects", async () => {
  expect(buildBuiltinChatCommands().find((c) => c.key === "fork")).toMatchObject({
    nativeName: "fork",
    textAliases: ["/fork"],
    modelIndependent: "always",
  });
  const disabled = params();
  expect(await handleForkCommand(disabled, false)).toBeNull();
  disabled.command.isAuthorizedSender = false;
  expect(await handleForkCommand(disabled, true)).toEqual({ shouldContinue: false });
  const dm = params();
  dm.isGroup = false;
  expect((await handleForkCommand(dm, true))?.reply?.text).toContain("not in DMs");
  const unthreaded = params();
  delete unthreaded.ctx.MessageThreadId;
  expect((await handleForkCommand(unthreaded, true))?.reply?.text).toContain("unthreaded chats");
  expect(records).toEqual([]);
  expect(sends).not.toHaveBeenCalled();
});

it.each([false, true])(
  "keeps the fork input and outcome through shared dispatch (ack fails=%s) without duplicating delivered acknowledgment",
  async (ackFails) => {
    await withOpenClawTestState({ label: "channel-fork" }, async (state) => {
      const cfg = {
        agents: { defaults: { workspace: state.workspaceDir } },
        messages: { groupChat: { visibleReplies: "automatic" as const } },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const source = await createGatewaySession({
        cfg,
        key: parentKey,
        commandSource: "test",
        creation: { via: "channel" },
      });
      if (!source.ok) {
        throw new Error(source.error.message);
      }
      const scope = { sessionKey: parentKey, sessionId: source.entry.sessionId };
      for (const [role, content, display] of [
        ["user", "Older context is inherited", true],
        ["assistant", "First visible excerpt", true],
        [
          "user",
          "Second visible excerpt\nMEDIA:https://example.invalid/copied.txt\n[[reply_to:literal]]",
          true,
        ],
        ["assistant", "Third visible excerpt", true],
        ["assistant", "PRIVATE_HIDDEN", false],
        ["toolResult", "PRIVATE_TOOL_OUTPUT", true],
      ] as const) {
        await appendTranscriptMessage(scope, {
          message: {
            role,
            content,
            display,
            ...(role === "assistant" ? { stopReason: "stop" } : {}),
          },
        });
      }
      const before = await loadTranscriptEvents(scope);
      const command = params();
      command.cfg = cfg;
      command.workspaceDir = state.workspaceDir;
      command.ctx.MessageSid = `fork-command-${ackFails}`;
      command.ctx.CommandSource = "native";
      command.ctx.CommandTargetSessionKey = parentKey;
      command.ctx.SessionKey = "agent:main:telegram:slash:user-1";
      command.sessionKey = command.ctx.SessionKey;
      inspectNativeCreate = async () => {
        const events = JSON.stringify(await loadTranscriptEvents(scope));
        expect(events).toContain("/fork Alternative");
        expect(events).toContain("Native thread creation and recap delivery are unconfirmed.");
        expect(events).not.toContain(
          "The last three available text messages are in the new thread",
        );
      };
      const replies: ReplyPayload[] = [];
      const acknowledgments: string[] = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          acknowledgments.push(payload.text ?? "");
          if (ackFails) {
            throw new Error("Original-thread acknowledgment failed");
          }
          return { visibleReplySent: true };
        },
      });
      await withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            cfg,
            ctx: finalizeInboundContext(command.ctx),
            dispatcher,
            replyResolver: async () => {
              const result = await handleForkCommand(command, true);
              assert(result?.reply);
              replies.push(result.reply);
              return result.reply;
            },
          }),
      });
      const reply = replies[0];
      assert(reply);
      expect(reply.text).toBe(
        "Fork created: new-thread. The last three available text messages are in the new thread; continue there.",
      );
      expect(getReplyPayloadMetadata(reply)?.sourceReplyTranscriptMirror).toMatchObject({
        sessionKey: parentKey,
        transcriptOwner: true,
      });
      expect(acknowledgments).toEqual([reply.text]);
      expect(command.ctx.SessionKey).toBe("agent:main:telegram:slash:user-1");
      expect(() => assertForkCurrent?.()).toThrow();
      const recorded = await loadTranscriptEvents(scope);
      expect(recorded.slice(0, before.length)).toEqual(before);
      const newEvents = recorded.slice(before.length);
      expect(newEvents).toHaveLength(3);
      expect(JSON.stringify(newEvents[0])).toContain("/fork Alternative");
      expect(JSON.stringify(newEvents[1])).toContain(
        "Native thread creation and recap delivery are unconfirmed.",
      );
      expect(JSON.stringify(newEvents[2])).toContain(reply.text);
      expect(records).toHaveLength(1);
      const binding = records[0]!;
      expect(
        await getSessionBindingService().resolveByConversationAsync(binding.conversation),
      ).toEqual(binding);
      const child = loadSessionEntryReadOnly({ sessionKey: binding.targetSessionKey });
      expect(child?.forkSource).toEqual({
        sessionKey: parentKey,
        sessionId: source.entry.sessionId,
      });
      expect(child?.sessionId).not.toBe(source.entry.sessionId);
      expect(sends).toHaveBeenCalledTimes(1);
      expect(sends.mock.calls[0]?.[0]).toMatchObject({
        to: "room",
        threadId: "new-thread",
        text: "Forked from the original thread. Earlier context is copied; new messages stay here.\n\nRecent messages:\nAssistant: First visible excerpt\nUser: Second visible excerpt\nMEDIA:https://example.invalid/copied.txt\n[[reply_to:literal]]\nAssistant: Third visible excerpt",
      });
      const childScope = { sessionKey: binding.targetSessionKey, sessionId: child!.sessionId };
      const childEvents = await loadTranscriptEvents(childScope);
      expect(JSON.stringify(childEvents)).toContain("Older context is inherited");
      expect(JSON.stringify(childEvents)).not.toContain("/fork Alternative");
      const recapRows = childEvents.filter((event) =>
        JSON.stringify(event).includes("Forked from the original thread."),
      );
      expect(recapRows).toHaveLength(1);
      expect(isTranscriptOnlyOpenClawAssistantMessage(Reflect.get(recapRows[0]!, "message"))).toBe(
        true,
      );
      await appendTranscriptMessage(childScope, {
        message: { role: "user", content: "ONLY_IN_FORK" },
      });
      expect(await loadTranscriptEvents(scope)).toEqual(recorded);
      expect(JSON.stringify(await loadTranscriptEvents(childScope))).toContain("ONLY_IN_FORK");
    });
  },
);

it.each([
  "native-unconfirmed",
  "invalid-binding",
  "plugin-replaced",
  "source-reset",
  "aborted",
] as const)("retains the copied session and refuses recap delivery after %s", async (failure) => {
  await withOpenClawTestState({ label: "fork-refusal" }, async (state) => {
    const cfg = { agents: { defaults: { workspace: state.workspaceDir } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const source = await createGatewaySession({
      cfg,
      key: parentKey,
      commandSource: "test",
      creation: { via: "channel" },
    });
    if (!source.ok) {
      throw new Error(source.error.message);
    }
    const scope = { sessionKey: parentKey, sessionId: source.entry.sessionId };
    await appendTranscriptMessage(scope, {
      message: { role: "user", content: "Preserved source" },
    });
    const command = params();
    command.cfg = cfg;
    const abort = new AbortController();
    command.opts = { abortSignal: abort.signal };
    inspectNativeCreate = async () => {
      if (failure === "native-unconfirmed") {
        throw new Error("Native create response lost");
      }
      if (failure === "invalid-binding") {
        returnedBindingPatch = { targetSessionKey: "agent:main:wrong" };
      }
      if (failure === "plugin-replaced") {
        setActivePluginRegistry(createTestRegistry([]));
      }
      if (failure === "source-reset") {
        await replaceSessionEntry(scope, { sessionId: "replacement-source", updatedAt: 2 });
      }
      if (failure === "aborted") {
        abort.abort(new Error("Command cancelled"));
      }
    };
    const result = await handleForkCommand(command, true);
    expect(result?.reply?.text).toContain("Copied session agent:main:fork:");
    expect(result?.reply?.text).toContain("thread creation was not confirmed");
    expect(sends).not.toHaveBeenCalled();
    const events = JSON.stringify(await loadTranscriptEvents(scope));
    expect(events).toContain("Native thread creation and recap delivery are unconfirmed.");
    expect(events).not.toContain("The last three available text messages are in the new thread");
    expect(
      getReplyPayloadMetadata(result!.reply!)?.sourceReplyTranscriptMirror?.transcriptOwner,
    ).toBe(failure === "native-unconfirmed" || failure === "invalid-binding" ? true : undefined);
  });
});

it("forks an active source only through its completed prefix", async () => {
  await withOpenClawTestState({ label: "active-channel-fork" }, async (state) => {
    const cfg = {
      agents: { defaults: { workspace: state.workspaceDir } },
      messages: { groupChat: { visibleReplies: "automatic" as const } },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const source = await createGatewaySession({
      cfg,
      key: parentKey,
      commandSource: "test",
      creation: { via: "channel" },
    });
    if (!source.ok) {
      throw new Error(source.error.message);
    }
    const scope = { sessionKey: parentKey, sessionId: source.entry.sessionId };
    for (const message of [
      { role: "user", content: "Completed question" },
      { role: "assistant", content: "Completed answer", stopReason: "stop" },
      { role: "user", content: "PRIVATE_ACTIVE_INPUT" },
      { role: "assistant", content: "PRIVATE_ACTIVE_TOOL", stopReason: "toolUse" },
    ]) {
      await appendTranscriptMessage(scope, { message });
    }
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    const operation = createReplyOperation({
      sessionKey: parentKey,
      sessionId: source.entry.sessionId,
      agentId: "main",
      resetTriggered: false,
      target: captureSessionTarget({
        storeScope: storePath,
        sessionKey: parentKey,
        incarnation: source.entry.sessionId,
        agentId: "main",
      }),
    });
    operation.setPhase("running");
    try {
      for (const id of ["active-fork-1", "active-fork-2"]) {
        const command = params();
        command.cfg = cfg;
        command.ctx.MessageSid = id;
        expect((await handleForkCommand(command, true))?.reply?.text).toContain("Fork created:");
        const childKey = records.at(-1)!.targetSessionKey;
        const child = loadSessionEntryReadOnly({ sessionKey: childKey });
        const events = JSON.stringify(
          await loadTranscriptEvents({ sessionKey: childKey, sessionId: child!.sessionId }),
        );
        expect(events).toContain("Completed question");
        expect(events).toContain("Completed answer");
        expect(events).not.toContain("PRIVATE_ACTIVE");
        expect(sends.mock.calls.at(-1)?.[0].text).not.toContain("PRIVATE_ACTIVE");
      }
    } finally {
      operation.complete();
    }
  });
});

it("retains a private fork and records its audience when channel authority closes during recap preparation", async () => {
  await withOpenClawTestState({ label: "fork-native-authority" }, async (state) => {
    const cfg = {
      agents: { defaults: { workspace: state.workspaceDir } },
      messages: { groupChat: { visibleReplies: "automatic" as const } },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const source = await createGatewaySession({
      cfg,
      key: parentKey,
      commandSource: "test",
      creation: { via: "channel" },
    });
    assert(source.ok);
    const scope = { sessionKey: parentKey, sessionId: source.entry.sessionId };
    await appendTranscriptMessage(scope, { message: { role: "user", content: "Source context" } });
    audienceNotice = "Private fork: only requester and bot are added.";
    let revoked = false;
    nativeCurrent = () => {
      if (revoked) {
        throw new Error("Native account retired");
      }
    };
    recapFormatter = (text) => {
      revoked = true;
      return { text };
    };
    const request = params();
    request.cfg = cfg;
    const outcome = await handleForkCommand(request, true);
    expect(records).toHaveLength(1);
    expect(outcome?.reply?.text).toContain(audienceNotice);
    expect(outcome?.reply?.text).toContain("recap was not delivered");
    expect(sends).not.toHaveBeenCalled();
    expect(JSON.stringify(await loadTranscriptEvents(scope))).toContain(audienceNotice);
    expect(
      getReplyPayloadMetadata(outcome!.reply!)?.sourceReplyTranscriptMirror?.transcriptOwner,
    ).toBe(true);
  });
});
