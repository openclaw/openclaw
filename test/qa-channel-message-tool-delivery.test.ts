import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getQaBusState,
  injectQaBusInboundMessage,
  qaChannelPlugin,
  type QaBusConversationKind,
  type QaBusMessage,
} from "../extensions/qa-channel/api.js";
import { createQaBusState, startQaBusServer } from "../extensions/qa-lab/api.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import { buildThreadingToolContext } from "../src/auto-reply/reply/agent-runner-utils.js";
import { resolveReplyToMode } from "../src/auto-reply/reply/reply-threading.js";
import * as bootstrapRegistry from "../src/channels/plugins/bootstrap-registry.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../src/gateway/message-action-turn-capability.js";
import { createStartAccountContext } from "../src/plugin-sdk/test-helpers/start-account-context.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createRuntimeChannel } from "../src/plugins/runtime/runtime-channel.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

afterEach(() => {
  vi.restoreAllMocks();
  setActivePluginRegistry(createTestRegistry([]));
});

const conversationId = "qa-shared-id";
const nonce = "implicit-target-nonce";
const conversationTargets = [
  { kind: "direct", root: `dm:${conversationId}`, thread: `thread:/v1/dm/${conversationId}` },
  { kind: "group", root: `group:${conversationId}`, thread: `thread:/v1/group/${conversationId}` },
  { kind: "channel", root: `channel:${conversationId}`, thread: `thread:${conversationId}` },
] as const;

async function withQaMessageTool(
  source: {
    kind: QaBusConversationKind;
    threadId?: string;
    trusted?: boolean;
    sourceReplyOnly?: boolean;
    accountId?: string;
  },
  exercise: (fixture: {
    tool: ReturnType<typeof createMessageTool>;
    inbound: QaBusMessage;
    busState: ReturnType<typeof createQaBusState>;
    baseUrl: string;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ prefix: "message-tool-qa-target-" }, async (state) => {
    const busState = createQaBusState();
    const bus = await startQaBusServer({ state: busState });
    const controller = new AbortController();
    let capability: string | undefined;
    // Reuse the real plugin's metadata instead of source-JIT loading another
    // copy; bootstrap loading is not part of this delivery boundary.
    vi.spyOn(bootstrapRegistry, "getBootstrapChannelPlugin").mockImplementation((id) => {
      expect(id).toBe("qa-channel");
      return qaChannelPlugin;
    });
    try {
      const config = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        session: { dmScope: "per-channel-peer" },
        channels: {
          "qa-channel": { baseUrl: bus.baseUrl, accounts: { secondary: {} } },
        },
      } satisfies OpenClawConfig;
      setRuntimeConfigSnapshot(config);
      // External-plugin canonicalization would hide a kind lost by the QA
      // producer. Match the bundled runtime's authorization path.
      setActivePluginRegistry(
        createTestRegistry([
          { pluginId: "qa-channel", source: "test", origin: "bundled", plugin: qaChannelPlugin },
        ]),
      );
      const { message: inbound } = await injectQaBusInboundMessage({
        baseUrl: bus.baseUrl,
        input: {
          accountId: source.accountId ?? "default",
          conversation: { kind: source.kind, id: conversationId },
          senderId: "qa-peer",
          senderName: "QA Peer",
          text: "Reply in this conversation.",
          threadId: source.threadId,
        },
      });
      let dispatched = 0;
      let dispatchError: Error | undefined;
      const channelRuntime = createRuntimeChannel({
        // Replace only the model dispatcher; ingress, session recording, tool
        // normalization, authorization, QA parsing, and HTTP bus delivery stay real.
        dispatchReplyFromConfig: async ({ ctx }) => {
          try {
            dispatched++;
            const toolContext = buildThreadingToolContext({
              sessionCtx: {
                ...ctx,
                ReplyToMode: resolveReplyToMode(config, "qa-channel", ctx.AccountId, ctx.ChatType),
              },
              config,
              hasRepliedRef: { value: false },
            });
            if (source.trusted) {
              capability = mintMessageActionTurnCapability({
                agentId: "main",
                runId: "qa-resource-run",
                sessionKey: ctx.SessionKey!,
                requesterAccountId: ctx.AccountId,
                requesterSenderId: ctx.SenderId,
                toolContext,
              });
            }
            const tool = createMessageTool({
              config,
              agentId: "main",
              agentSessionKey: ctx.SessionKey,
              agentAccountId: ctx.AccountId,
              ...toolContext,
              messageActionTurnCapability: capability,
              runId: source.trusted ? "qa-resource-run" : undefined,
              sourceReplyOnly: source.sourceReplyOnly,
              sourceReplyDeliveryMode: "message_tool_only",
              workspaceDir: state.workspaceDir,
            });
            await exercise({ tool, inbound, busState, baseUrl: bus.baseUrl });
          } catch (error) {
            dispatchError = toErrorObject(error, "QA message-tool dispatch failed");
          } finally {
            controller.abort();
          }
          return {
            queuedFinal: false,
            counts: { tool: 0, block: 0, final: 0 },
            observedReplyDelivery: true,
          };
        },
      });
      const startAccount = qaChannelPlugin.gateway?.startAccount;
      expect(startAccount).toBeDefined();
      await startAccount!({
        ...createStartAccountContext({
          cfg: config,
          account: qaChannelPlugin.config.resolveAccount(config, inbound.accountId),
          abortSignal: controller.signal,
        }),
        channelRuntime,
      });
      expect(dispatched).toBe(1);
      if (dispatchError) {
        throw dispatchError;
      }
    } finally {
      if (capability) {
        revokeMessageActionTurnCapability(capability);
      }
      controller.abort();
      await bus.stop();
    }
  });
}

describe("QA message-tool current conversation delivery", () => {
  it.each(conversationTargets)("replies in the implicit $kind conversation", async ({ kind }) => {
    await withQaMessageTool({ kind }, async ({ tool, inbound, baseUrl }) => {
      await tool.execute("qa-send", { action: "send", message: nonce, final: true });
      const snapshot = await getQaBusState(baseUrl);
      const outbound = snapshot.messages.filter((message) => message.direction === "outbound");
      expect(outbound).toMatchObject([
        {
          conversation: inbound.conversation,
          accountId: inbound.accountId,
          text: nonce,
          replyToId: inbound.id,
          attachments: [],
        },
      ]);
      expect(outbound[0]?.threadId).toBeUndefined();
      expect(snapshot.threads).toEqual([]);
    });
  });

  it.each([
    { sourceReplyOnly: true, trusted: false },
    { sourceReplyOnly: false, trusted: true },
    { sourceReplyOnly: true, trusted: true },
  ])("bounds source replies with %j", async (authority) => {
    await withQaMessageTool(
      { ...authority, kind: "direct", threadId: "topic", accountId: "secondary" },
      async ({ tool, inbound, baseUrl }) => {
        const send = (args: Record<string, unknown>) =>
          tool.execute("source-send", { action: "send", message: nonce, ...args });
        await expect(send({ accountId: "default" })).rejects.toThrow(
          authority.sourceReplyOnly ? "another channel account" : "trusted current account",
        );
        if (authority.sourceReplyOnly) {
          for (const args of [
            { target: `dm:${conversationId}-other` },
            { target: `group:${conversationId}` },
            { target: `thread:/v1/dm/${conversationId}/other` },
            { threadId: "other" },
            { replyTo: "foreign-message" },
            { topLevel: true },
          ]) {
            await expect(send(args)).rejects.toThrow("Completion source replies");
          }
        }
        await send({});
        await send({ target: `dm:${conversationId}`, accountId: "SECONDARY", replyTo: inbound.id });
        const snapshot = await getQaBusState(baseUrl);
        expect(
          snapshot.messages.filter((message) => message.direction === "outbound"),
        ).toMatchObject(
          Array.from({ length: 2 }, () => ({
            conversation: inbound.conversation,
            accountId: "secondary",
            text: nonce,
            replyToId: inbound.id,
            threadId: "topic",
          })),
        );
      },
    );
  });

  it.each([
    [0, undefined, "default"],
    [0, "topic", "secondary"],
    [1, "topic", "default"],
    [2, undefined, "secondary"],
  ] as const)("scopes read/react/edit to source %s/%s/%s", async (index, threadId, accountId) => {
    const { kind, root, thread } = conversationTargets[index];
    await withQaMessageTool(
      { kind, threadId, accountId, trusted: true },
      async ({ tool, inbound, busState, baseUrl }) => {
        const otherAccount = accountId === "default" ? "secondary" : "default";
        const foreignRoots = conversationTargets
          .filter((target) => target.kind !== kind)
          .map((target) => target.root);
        const addMessage = (
          text: string,
          overrides: Partial<Parameters<typeof busState.addOutboundMessage>[0]> = {},
        ) => busState.addOutboundMessage({ to: root, accountId, threadId, text, ...overrides });
        const own = addMessage("original");
        const foreignMessages = [
          ...foreignRoots.map((to) => ({ name: "kind", to })),
          { name: "root", to: `${root}-other` },
          { name: "thread", threadId: "other" },
          ...(threadId ? [{ name: "unthreaded", threadId: undefined }] : []),
          { name: "account", accountId: otherAccount },
        ].map(({ name, ...params }) => ({
          name,
          message: addMessage(`foreign ${name}`, params),
        }));
        const inboundRead = await tool.execute("read-inbound", {
          action: "read",
          messageId: inbound.id,
        });
        expect(inboundRead.details).toMatchObject({ message: inbound });
        for (const args of [
          { action: "read" },
          { action: "react", emoji: "white_check_mark" },
          { action: "edit", message: "edited" },
        ]) {
          const reject = (label: string, extra: Record<string, unknown>, reason: string) =>
            expect(
              tool.execute(`${label}-${args.action}`, { ...args, messageId: own.id, ...extra }),
            ).rejects.toThrow(reason);
          for (const { name, message } of foreignMessages) {
            await reject(
              `foreign-${name}`,
              { messageId: message.id },
              name === "account" ? "message not found" : "not in the selected conversation",
            );
          }
          for (const target of [...foreignRoots, `${root}-other`, `${thread}/other`]) {
            await reject(
              "foreign-target",
              { target },
              "requires the exact current conversation and account",
            );
          }
          await reject("foreign-thread", { threadId: "other" }, "not in the selected conversation");
          await reject("foreign-account", { accountId: otherAccount }, "trusted current account");
          for (const target of [
            {},
            { target: root },
            { to: root },
            { channelId: root },
            // Read-capable actions use the host-owned root plus explicit thread identity.
            ...(threadId ? [{ threadId }] : []),
          ]) {
            const result = await tool.execute(`own-${args.action}`, {
              ...args,
              ...target,
              messageId: own.id,
            });
            expect(result.details).toMatchObject({
              message: { id: own.id, conversation: inbound.conversation, accountId },
            });
            if (threadId) {
              expect(result.details).toHaveProperty("message.threadId", threadId);
            } else {
              expect(result.details).not.toHaveProperty("message.threadId");
            }
          }
        }
        const snapshot = await getQaBusState(baseUrl);
        expect(snapshot.messages).toHaveLength(foreignMessages.length + 2);
        const edited = snapshot.messages.find((message) => message.id === own.id);
        expect(edited).toMatchObject({
          accountId,
          conversation: inbound.conversation,
          text: "edited",
          reactions: [expect.objectContaining({ emoji: "white_check_mark", senderId: "openclaw" })],
        });
        expect(edited?.threadId).toBe(threadId);
        expect(snapshot.messages).toEqual(
          expect.arrayContaining([inbound, ...foreignMessages.map(({ message }) => message)]),
        );
      },
    );
  });

  it.each(conversationTargets)(
    "preserves thread and reply intent through $kind ingress",
    async ({ kind, root, thread }) => {
      await withQaMessageTool({ kind, threadId: "topic" }, async ({ tool, inbound, baseUrl }) => {
        type SendCase = [
          args: Record<string, unknown>,
          threadId?: string,
          replyToId?: string,
          conversation?: QaBusMessage["conversation"],
        ];
        const cases: SendCase[] = [
          [{}, "topic", inbound.id],
          [{ target: root }, "topic", inbound.id],
          [{ to: root }, "topic", inbound.id],
          [
            { target: conversationId },
            kind === "channel" ? "topic" : undefined,
            kind === "channel" ? inbound.id : undefined,
            { kind: "channel", id: conversationId },
          ],
          [{ target: `${thread}/topic` }, "topic", inbound.id],
          [{ target: `${thread}/other` }, "other"],
          [{ threadId: "other" }, "other", inbound.id],
          [{ replyTo: "chosen-message" }, "topic", "chosen-message"],
          [
            { target: `${root}-other` },
            undefined,
            undefined,
            { kind, id: `${conversationId}-other` },
          ],
          [
            { target: `${kind === "direct" ? "group" : "dm"}:${conversationId}` },
            undefined,
            undefined,
            { kind: kind === "direct" ? "group" : "direct", id: conversationId },
          ],
          ...[{ topLevel: true }, { threadId: null }].flatMap((optOut): SendCase[] => [
            [optOut],
            [{ target: root, ...optOut }],
            [{ target: `${thread}/other`, ...optOut }, "other"],
            [{ ...optOut, replyTo: "chosen-message" }, undefined, "chosen-message"],
          ]),
          [{ topLevel: true, threadId: null }],
          [{ threadId: "other", topLevel: true }, "other"],
          [
            { threadId: "other", replyTo: "chosen-message", topLevel: true },
            "other",
            "chosen-message",
          ],
        ];
        for (const [args] of cases) {
          const name = JSON.stringify(args);
          await tool.execute(name, {
            action: "send",
            message: name,
            ...args,
          });
        }
        await expect(
          tool.execute("conflicting-thread", {
            action: "send",
            target: `${thread}/topic`,
            threadId: "other",
            message: nonce,
          }),
        ).rejects.toThrow("conflicts with the explicit threadId");
        const snapshot = await getQaBusState(baseUrl);
        const outbound = snapshot.messages.filter((message) => message.direction === "outbound");
        expect(outbound).toHaveLength(cases.length);
        for (const [index, [args, threadId, replyToId, conversation]] of cases.entries()) {
          const name = JSON.stringify(args);
          expect.soft(outbound[index], name).toMatchObject({
            conversation: conversation ?? inbound.conversation,
            accountId: inbound.accountId,
            text: name,
            attachments: [],
          });
          expect.soft(outbound[index]?.threadId, name).toBe(threadId);
          expect.soft(outbound[index]?.replyToId, name).toBe(replyToId);
        }
      });
    },
  );
});
