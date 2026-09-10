import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConversationListResultSchema,
  ConversationSendResultSchema,
  ConversationTurnResultSchema,
} from "../../../packages/gateway-protocol/src/schema/agent.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { MessageActionResult } from "../../infra/outbound/message-action-contracts.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  DEFAULT_GATEWAY_HTTP_TOOL_DENY,
  GATEWAY_OWNER_ONLY_CORE_TOOLS,
} from "../../security/dangerous-tools.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runBridgeRequest } from "../code-mode-bridge.js";
import { createCodeModeCatalogProjection } from "../code-mode-catalog.js";
import { CodeModeProgramDataInbox } from "../code-mode-program-data.js";
import { resolveCodeModeConfig } from "../code-mode-runtime.js";
import type { AgentToolResult } from "../runtime/index.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { compactToolSearchCatalogEntry } from "../tool-search-catalog.js";
import { ToolSearchRuntime } from "../tool-search-runtime.js";
import type { ToolSearchCatalogRef } from "../tool-search-types.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} from "../tool-search.js";
import {
  createConversationsListTool,
  createConversationsSendTool,
  createConversationsTurnTool,
} from "./conversation-tools.js";
import { createMessageTool } from "./message-tool-execution.js";
import { resetTurnSendLedgerForTest } from "./turn-send-ledger.js";

// conversations_send declares its output schema inline (the Gateway send result
// plus an optional turnSendNotice). The schema is module-private, so read it back
// from the tool's outputSchema — every instance points to the same module const.
const conversationSendToolResultSchema = createConversationsSendTool().outputSchema!;

afterEach(() => {
  resetTurnSendLedgerForTest();
  resetPluginRuntimeStateForTest();
});

// buildTurnSendTargetKey canonicalizes the target through the channel plugin's
// provider normalizer. Register the reef fixture as a loaded plugin so that read
// resolves from the loaded registry instead of falling through to bundled channel
// runtime materialization, which would cold-load every bundled channel under tsx.
function registerReefTestPlugin() {
  const plugin = {
    id: "reef",
    meta: {
      id: "reef",
      label: "Reef",
      selectionLabel: "Reef",
      docsPath: "/channels/reef",
      blurb: "reef test plugin",
    },
    capabilities: { chatTypes: ["direct", "group"], media: true },
    config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
    actions: {
      describeMessageTool: () => ({ actions: ["send"], capabilities: [] }),
    },
  } as unknown as ChannelPlugin;
  setActivePluginRegistry(createTestRegistry([{ pluginId: "reef", source: "test", plugin }]));
}

beforeEach(() => {
  registerReefTestPlugin();
});

const conversation = {
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  channel: "reef",
  accountId: "default",
  kind: "direct" as const,
  target: "reef:peer-agent",
  sessionId: "shared-main-session",
  sessionKey: "agent:main:main",
  role: "participant" as const,
  firstSeenAt: 100,
  lastSeenAt: 200,
};

type MockGatewayCall = {
  method: string;
  params: Record<string, unknown>;
  config?: unknown;
  onSignalAbort?: (
    request: (method: string, params: unknown, options: unknown) => Promise<unknown>,
  ) => Promise<void>;
};

function createDeps() {
  const callGatewayMock = vi.fn(async (input: MockGatewayCall) =>
    input.method === "conversations.list"
      ? {
          conversations: [
            {
              conversationRef: conversation.conversationRef,
              channel: conversation.channel,
              accountId: conversation.accountId,
              kind: conversation.kind,
              target: conversation.target,
              firstSeenAt: conversation.firstSeenAt,
              lastSeenAt: conversation.lastSeenAt,
            },
          ],
        }
      : input.method === "conversations.send"
        ? {
            status: "sent" as const,
            conversationRef: conversation.conversationRef,
            channel: "reef",
            messageId: "reef-outbound-1",
            queueId: "queue-1",
          }
        : {
            status: "replied" as const,
            conversationRef: conversation.conversationRef,
            channel: "reef",
            messageId: "reef-outbound-1",
            correlationPersisted: true,
            reply: {
              conversationRef: conversation.conversationRef,
              messageId: "reef-inbound-1",
              replyToId: "reef-outbound-1",
              text: "peer acknowledged",
              timestamp: 300,
            },
          },
  );
  // The registry resolves the opaque ref to its real (channel, account, target)
  // route; the budget ledger keys on that route, not the raw conversationRef.
  const resolveConversationMock = vi.fn(() => conversation);
  return {
    callGateway: callGatewayMock as never,
    resolveConversation: resolveConversationMock as never,
    callGatewayMock,
    resolveConversationMock,
  };
}

describe("conversation tools", () => {
  it("declares exact Gateway output contracts and promotes only bounded complete hints", async () => {
    const deps = createDeps();
    const list = createConversationsListTool({ agentId: "main" }, deps);
    const send = createConversationsSendTool({ agentId: "main" }, deps);
    const turn = createConversationsTurnTool({ agentId: "main" }, deps);
    const listResult = await list.execute("list-contract", {});
    const sendResult = await send.execute("send-contract", {
      conversationRef: conversation.conversationRef,
      message: "hello peer",
    });
    const turnResult = await turn.execute("turn-contract", {
      conversationRef: conversation.conversationRef,
      message: "please acknowledge",
    });

    expect(list.outputSchema).toBe(ConversationListResultSchema);
    // conversations_send declares a tool-local superset of the Gateway send result
    // (adds the optional turnSendNotice) so Code Mode can project the send-budget
    // guidance; the Gateway protocol schema itself is unchanged.
    expect(send.outputSchema).toBe(conversationSendToolResultSchema);
    expect(turn.outputSchema).toBe(ConversationTurnResultSchema);
    expect(Value.Check(list.outputSchema!, listResult.details)).toBe(true);
    expect(Value.Check(send.outputSchema!, sendResult.details)).toBe(true);
    expect(Value.Check(turn.outputSchema!, turnResult.details)).toBe(true);
    expect(compactToolOutputHint(list.outputSchema)).toBe(
      '{ conversations: Array<{ accountId: string; channel: string; conversationRef: string; firstSeenAt: number; kind: "direct" | "group" | "channel"; lastSeenAt: number; target: string; label?: string; threadId?: string }> }',
    );
    expect(compactToolOutputHint(send.outputSchema)).toBe(
      '{ channel: string; conversationRef: string; status: "sent" | "queued" | "suppressed" | "unknown"; messageId?: string; queueId?: string; turnSendNotice?: string }',
    );
    expect(compactToolOutputHint(turn.outputSchema)).toBe(
      '{ channel: string; conversationRef: string; correlationPersisted: boolean; messageId: string; reply: { conversationRef: string; messageId: string; text: string; timestamp: number; replyToId?: string; threadId?: string; transcriptArtifactId?: string; transcriptMessageId?: string }; status: "replied" } | { channel: string; conversationRef: string; correlationPersisted: boolean; messageId: string; status: "timeout" } | { channel: string; conversationRef: string; correlationPersisted: boolean; error: string; status: "sent" | "queued" | "suppressed" | "unknown"; messageId?: string }',
    );
  });

  it("keeps the conversations_send tool schema a strict superset of the Gateway send result", () => {
    // The tool-local schema is hand-maintained (the Gateway wire schema is not mutated),
    // so guard against silent drift: it must mirror every Gateway field with an identical
    // JSON-schema definition and add only the optional turnSendNotice. Without this, an
    // upstream field addition/tightening would surface only as a runtime throw in Code
    // Mode's output-schema check (assertCatalogOutputMatchesSchema), never in CI.
    const gatewayProps = (ConversationSendResultSchema as { properties: Record<string, unknown> })
      .properties;
    const toolProps = (conversationSendToolResultSchema as { properties: Record<string, unknown> })
      .properties;
    for (const key of Object.keys(gatewayProps)) {
      expect(JSON.stringify(toolProps[key])).toBe(JSON.stringify(gatewayProps[key]));
    }
    expect(Object.keys(toolProps).filter((key) => !(key in gatewayProps))).toEqual([
      "turnSendNotice",
    ]);
    expect(
      (conversationSendToolResultSchema as { additionalProperties?: unknown }).additionalProperties,
    ).toBe(false);
    // Per-property JSON ignores TypeBox optionality (OptionalKind lives in the
    // top-level `required` array, not the property schema), so also compare the
    // normalized required sets. The only added field (turnSendNotice) is optional,
    // so the tool schema's required set must equal the Gateway's exactly — an
    // optional<->required flip on any mirrored field (or on turnSendNotice) diverges
    // here instead of surfacing only as a Code Mode output-schema throw at runtime.
    const sortedRequired = (schema: unknown) =>
      ((schema as { required?: string[] }).required ?? []).toSorted();
    const gatewayRequired = sortedRequired(ConversationSendResultSchema);
    const toolRequired = sortedRequired(conversationSendToolResultSchema);
    expect(toolRequired).toEqual(gatewayRequired);
    // turnSendNotice must stay optional so a details-less or normalization-only send
    // still validates against the declared schema.
    expect(toolRequired).not.toContain("turnSendNotice");
  });

  it("lists opaque external addresses independently from sessions", async () => {
    const deps = createDeps();
    const result = await createConversationsListTool({ agentId: "main" }, deps).execute("list", {
      channel: "reef",
      query: "@peer-agent",
    });

    expect(deps.callGatewayMock).toHaveBeenCalledWith({
      method: "conversations.list",
      params: { agentId: "main", channel: "reef", query: "@peer-agent", limit: 50 },
    });
    expect(result.details).toEqual({
      conversations: [
        {
          conversationRef: conversation.conversationRef,
          channel: "reef",
          accountId: "default",
          kind: "direct",
          target: "reef:peer-agent",
          firstSeenAt: 100,
          lastSeenAt: 200,
        },
      ],
    });
  });

  it("routes sends through the Gateway with a stable operation id", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(
      {
        agentId: "main",
        agentSessionId: "operator-session",
        agentSessionKey: "agent:main:telegram:direct:operator",
        config: {},
      },
      deps,
    );
    const args = {
      conversationRef: conversation.conversationRef,
      message: "hello peer",
    };

    const firstResult = await tool.execute("tool-call-1", args);
    const secondResult = await tool.execute("tool-call-1", args);
    const first = deps.callGatewayMock.mock.calls[0]![0];
    const second = deps.callGatewayMock.mock.calls[1]![0];

    expect(first).toMatchObject({
      method: "conversations.send",
      params: {
        agentId: "main",
        sourceSessionKey: "agent:main:telegram:direct:operator",
        conversationRef: conversation.conversationRef,
        message: "hello peer",
      },
      config: {},
    });
    expect(first.params.operationId).toMatch(/^convop_[a-f0-9]{32}$/u);
    expect(second.params.operationId).toBe(first.params.operationId);
    expect(firstResult.details).toEqual(secondResult.details);
    expect(firstResult.details).toMatchObject({
      status: "sent",
      messageId: "reef-outbound-1",
      queueId: "queue-1",
    });
  });

  it("reports Gateway suppression without claiming delivery", async () => {
    const deps = createDeps();
    deps.callGatewayMock.mockResolvedValueOnce({
      status: "suppressed",
      conversationRef: conversation.conversationRef,
      channel: "reef",
      queueId: "queue-suppressed",
    } as never);

    const result = await createConversationsSendTool({ agentId: "main", config: {} }, deps).execute(
      "suppressed-call",
      {
        conversationRef: conversation.conversationRef,
        message: "suppressed hello",
      },
    );

    expect(result.details).toEqual({
      status: "suppressed",
      conversationRef: conversation.conversationRef,
      channel: "reef",
      queueId: "queue-suppressed",
    });
  });

  it("keeps a transient Gateway send failure retryable under the stable tool call id", async () => {
    const deps = createDeps();
    deps.callGatewayMock.mockRejectedValueOnce(new Error("gateway unavailable"));
    const tool = createConversationsSendTool({ agentId: "main", config: {} }, deps);
    const args = {
      conversationRef: conversation.conversationRef,
      message: "retry me",
    };

    await expect(tool.execute("retryable-call", args)).rejects.toThrow("gateway unavailable");
    await expect(tool.execute("retryable-call", args)).resolves.toMatchObject({
      details: { status: "sent", messageId: "reef-outbound-1" },
    });
    const first = deps.callGatewayMock.mock.calls[0]![0];
    const second = deps.callGatewayMock.mock.calls[1]![0];
    expect(second.params.operationId).toBe(first.params.operationId);
  });

  it("uses a stable operation id for correlated turns and cancels on abort", async () => {
    const deps = createDeps();
    const tool = createConversationsTurnTool(
      {
        agentId: "main",
        agentSessionId: "operator-session",
        agentSessionKey: "agent:main:telegram:direct:operator",
        config: {},
      },
      deps,
    );
    await tool.execute("turn-call", {
      conversationRef: conversation.conversationRef,
      message: "please acknowledge",
      timeoutSeconds: 12,
    });
    await tool.execute("turn-call", {
      conversationRef: conversation.conversationRef,
      message: "please acknowledge",
      timeoutSeconds: 12,
    });

    const first = deps.callGatewayMock.mock.calls[0]![0];
    const second = deps.callGatewayMock.mock.calls[1]![0];
    expect(first.params.turnId).toMatch(/^convop_[a-f0-9]{32}$/u);
    expect(second.params.turnId).toBe(first.params.turnId);
    const request = vi.fn(async () => ({ cancelled: true }));
    await first.onSignalAbort?.(request);
    expect(request).toHaveBeenCalledWith(
      "conversations.turn.cancel",
      { agentId: "main", turnId: first.params.turnId },
      { timeoutMs: 5_000 },
    );
  });

  it("validates references and owner access before Gateway delivery", async () => {
    const deps = createDeps();
    await expect(
      createConversationsSendTool({ agentId: "main", config: {} }, deps).execute("send", {
        conversationRef: "not-a-conversation",
        message: "hello",
      }),
    ).rejects.toThrow("Invalid conversationRef");

    for (const createTool of [
      createConversationsListTool,
      createConversationsSendTool,
      createConversationsTurnTool,
    ]) {
      const tool = createTool({ agentId: "main", senderIsOwner: false, config: {} } as never, deps);
      await expect(
        tool.execute("blocked", {
          conversationRef: conversation.conversationRef,
          message: "blocked",
        }),
      ).rejects.toThrow("require owner access");
    }
    expect(deps.callGatewayMock).not.toHaveBeenCalled();
    for (const name of ["conversations_list", "conversations_send", "conversations_turn"]) {
      expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain(name);
      expect(DEFAULT_GATEWAY_HTTP_TOOL_DENY).toContain(name);
    }
  });
});

describe("conversations_send per-turn send budget", () => {
  const budgetOptions = {
    agentId: "main",
    agentSessionKey: "agent:main:reef:direct:operator",
    runId: "run-conv-1",
    config: {},
  } as const;

  function softNotice(result: { content: Array<{ type: string; text?: string }> }) {
    return result.content
      .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
      .map((entry) => entry.text)
      .find((text) => text.includes("already sent"));
  }

  function blockedNotice(result: { content: Array<{ type: string; text?: string }> }) {
    return result.content
      .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
      .map((entry) => entry.text)
      .find((text) => text.startsWith("Blocked:"));
  }

  // conversations_send declares the tool-local ConversationSendToolResultSchema
  // (the closed Gateway send result plus an optional turnSendNotice). A capped send
  // must return details valid under that schema and carry the block reason in the
  // declared turnSendNotice field so it survives Code Mode's details projection,
  // while still keeping the human-readable reason in the text content.
  function expectSchemaValidCappedResult(result: {
    content: Array<{ type: string; text?: string }>;
    details: unknown;
  }) {
    const blockedText = blockedNotice(result);
    expect(blockedText).toContain("configured limit");
    expect(Value.Check(conversationSendToolResultSchema, result.details)).toBe(true);
    // The declared extra field is intentionally outside the closed Gateway schema;
    // this is exactly why conversations_send wires the tool-local superset.
    expect(Value.Check(ConversationSendResultSchema, result.details)).toBe(false);
    expect(result.details).toEqual({
      status: "suppressed",
      conversationRef: conversation.conversationRef,
      channel: "reef",
      turnSendNotice: blockedText,
    });
  }

  it("returns a schema-valid capped result with the block reason in text, not details", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(
      { ...budgetOptions, config: { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } },
      deps,
    );
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    await tool.execute("c1", args);
    const blocked = await tool.execute("c2", args);
    expectSchemaValidCappedResult(blocked);
    // No extra fields leaked into details that would fail the closed output schema.
    expect(blocked.details).not.toHaveProperty("reason");
    expect(blocked.details).not.toHaveProperty("message");
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("passes the Code Mode output-schema check on the capped path", async () => {
    // In Code Mode the runtime validates the returned details against the tool's
    // declared outputSchema (assertCatalogOutputMatchesSchema). A capped result with
    // extra details fields would throw there; the schema-valid shape must not.
    const deps = createDeps();
    const tool = createConversationsSendTool(
      { ...budgetOptions, config: { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } },
      deps,
    );
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [tool] });
    const runtime = new ToolSearchRuntime(
      { catalogRef },
      resolveToolSearchConfig({ tools: { toolSearch: { enabled: true, mode: "code" } } } as never),
    );
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    // First send is admitted; the second is capped and returns the schema-valid
    // suppressed shape, so the output-schema check must accept it instead of throwing.
    await runtime.call("conversations_send", args);
    await expect(runtime.call("conversations_send", args)).resolves.toMatchObject({
      result: { details: { status: "suppressed", channel: "reef" } },
    });
  });

  it("appends a soft reminder from the second send to the same conversation this turn", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(budgetOptions, deps);
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    const first = await tool.execute("c1", args);
    const second = await tool.execute("c2", args);
    expect(softNotice(first)).toBeUndefined();
    expect(softNotice(second)).toContain("already sent 2 messages");
    // The reminder also rides in declared details so a Code Mode guest (which only
    // receives the projected details) sees it; the two strings are identical.
    expect(second.details).toMatchObject({
      status: "sent",
      turnSendNotice: expect.stringContaining("already sent 2 messages"),
    });
    expect(Value.Check(conversationSendToolResultSchema, second.details)).toBe(true);
    expect(first.details).not.toHaveProperty("turnSendNotice");
  });

  it.each(["suppressed", "queued", "unknown"] as const)(
    "does not count a %s (unconfirmed) Gateway result",
    async (status) => {
      const deps = createDeps();
      deps.callGatewayMock.mockResolvedValueOnce({
        status,
        conversationRef: conversation.conversationRef,
        channel: "reef",
      } as never);
      const tool = createConversationsSendTool(budgetOptions, deps);
      const args = { conversationRef: conversation.conversationRef, message: "hi" };
      await tool.execute("c1", args);
      const second = await tool.execute("c2", args);
      // Only a confirmed "sent" counts. This first send was not confirmed delivered
      // (queued is enqueue-only; suppressed/unknown never reached the peer), so the
      // following send is the first success and draws no nudge.
      expect(softNotice(second)).toBeUndefined();
    },
  );

  it("counts a queued-then-sent pair as a single first delivery under the hard cap", async () => {
    const deps = createDeps();
    // First send is only enqueued (unconfirmed): it must not consume the cap.
    deps.callGatewayMock.mockResolvedValueOnce({
      status: "queued",
      conversationRef: conversation.conversationRef,
      channel: "reef",
      queueId: "queue-1",
    } as never);
    const tool = createConversationsSendTool(
      { ...budgetOptions, config: { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } },
      deps,
    );
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    const queued = await tool.execute("c1", args);
    // Queued does not count, so the cap is untouched and the Gateway was still reached.
    expect(queued.details).toMatchObject({ status: "queued" });
    expect(softNotice(queued)).toBeUndefined();
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);
    // The subsequent confirmed "sent" is the first counted delivery, so it is admitted.
    const sent = await tool.execute("c2", args);
    expect(sent.details).toMatchObject({ status: "sent" });
    expect(softNotice(sent)).toBeUndefined();
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(2);
    // With the cap now reached by that one confirmed delivery, a third send is blocked
    // before the Gateway call.
    const blocked = await tool.execute("c3", args);
    expectSchemaValidCappedResult(blocked);
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(2);
  });

  it("lets an idempotent replay through the cap without double-counting or a fresh nudge", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(
      { ...budgetOptions, config: { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } },
      deps,
    );
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    // 1st send consumes the single-send budget.
    const first = await tool.execute("call-1", args);
    expect(first.details).toMatchObject({ status: "sent" });
    expect(softNotice(first)).toBeUndefined();
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);

    // Same toolCallId again -> same operationId. The Gateway resolves it to the
    // completed operation and returns "sent" without re-delivering, so it must not be
    // capped, must reach the Gateway, and must neither double-count nor nudge afresh.
    const replay = await tool.execute("call-1", args);
    expect(replay.details).toMatchObject({ status: "sent" });
    expect(softNotice(replay)).toBeUndefined();
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(2);

    // A THIRD, distinct toolCallId is a genuinely new send and is blocked by the cap
    // that the single counted delivery already reached.
    const blocked = await tool.execute("call-2", args);
    expectSchemaValidCappedResult(blocked);
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(2);
  });

  it("resets the count for a new turn (new runId)", async () => {
    const deps = createDeps();
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    await createConversationsSendTool(budgetOptions, deps).execute("c1", args);
    const nextTurn = createConversationsSendTool({ ...budgetOptions, runId: "run-conv-2" }, deps);
    const result = await nextTurn.execute("c1", args);
    expect(softNotice(result)).toBeUndefined();
  });

  it("blocks before the Gateway call once the opt-in hard cap is reached", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(
      { ...budgetOptions, config: { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } },
      deps,
    );
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    await tool.execute("c1", args);
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);
    const blocked = await tool.execute("c2", args);
    expectSchemaValidCappedResult(blocked);
    // The blocked send never reached the Gateway.
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses the soft reminder when turnSendNudge is disabled", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(
      { ...budgetOptions, config: { tools: { message: { turnSendNudge: false } } } },
      deps,
    );
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    await tool.execute("c1", args);
    const second = await tool.execute("c2", args);
    // The nudge is gated off, but both sends still reached the Gateway.
    expect(softNotice(second)).toBeUndefined();
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(2);
  });

  it("still enforces the hard cap when turnSendNudge is disabled", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(
      {
        ...budgetOptions,
        config: { tools: { message: { maxMessagesPerTurnPerTarget: 1, turnSendNudge: false } } },
      },
      deps,
    );
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    await tool.execute("c1", args);
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);
    const blocked = await tool.execute("c2", args);
    // Counting still ran past the first send, so the cap blocks the second.
    expectSchemaValidCappedResult(blocked);
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);
  });
});

describe("message and conversations_send share the per-turn budget", () => {
  // Both tools route to the same real recipient reef:peer-agent under the default
  // account: the message tool resolves it as an explicit target, and the registry
  // resolves the conv ref to the same (channel, account, target). Alternating them
  // must therefore share one ledger key rather than evade the nudge and hard cap.
  const sessionKey = "agent:main:reef:direct:operator";
  const runId = "run-mixed-1";
  const peerTarget = conversation.target;

  function softNotice(result: { content: Array<{ type: string; text?: string }> }) {
    return result.content
      .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
      .map((entry) => entry.text)
      .find((text) => text.includes("already sent"));
  }

  function createMixedMessageTool(config: Record<string, unknown>) {
    return createMessageTool({
      currentChannelProvider: "reef",
      currentChannelId: "reef:operator",
      agentAccountId: "default",
      agentSessionKey: sessionKey,
      runId,
      sourceReplyDeliveryMode: "message_tool_only",
      config: config as never,
      runMessageAction: (async () =>
        ({
          kind: "send",
          action: "send",
          channel: "reef",
          to: peerTarget,
          handledBy: "plugin",
          payload: {},
          dryRun: false,
        }) satisfies MessageActionResult) as never,
      resolveCommandSecretRefsViaGateway: (async ({ config: cfg }: { config: unknown }) => ({
        resolvedConfig: cfg,
        diagnostics: [],
      })) as never,
      getScopedChannelsCommandSecretTargets: (() => ({ targetIds: new Set<string>() })) as never,
    });
  }

  async function sendViaMessageTool(tool: ReturnType<typeof createMessageTool>, message: string) {
    return tool.execute(`msg-${message}`, {
      action: "send",
      channel: "reef",
      to: peerTarget,
      message,
    });
  }

  it("nudges on the second cross-tool send and blocks the third at the cap", async () => {
    const config = { tools: { message: { maxMessagesPerTurnPerTarget: 2 } } };
    const deps = createDeps();
    const messageTool = createMixedMessageTool(config);
    const conversationTool = createConversationsSendTool(
      { agentId: "main", agentSessionKey: sessionKey, runId, config: config as never },
      deps,
    );

    // 1st send (message tool): silent.
    const first = await sendViaMessageTool(messageTool, "hello");
    expect(softNotice(first)).toBeUndefined();

    // 2nd send (conversations_send, same recipient): nudge fires despite the tool switch.
    const second = await conversationTool.execute("conv-1", {
      conversationRef: conversation.conversationRef,
      message: "hello again",
    });
    expect(softNotice(second)).toContain("already sent 2 messages");

    // 3rd send (message tool again): blocked by the shared cap of 2.
    const third = await sendViaMessageTool(messageTool, "third variant");
    expect(third.details).toMatchObject({
      status: "suppressed",
      reason: "turn_send_budget_exhausted",
    });
    // The blocked send never reached the runner-backed gateway path.
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);
  });

  // A no-target source reply must resolve to the concrete current target, not a
  // sentinel: the operator is replying to reef:peer-agent, which is also the conv
  // ref's target. Its ledger key must equal the one conversations_send builds for
  // the same peer, or alternating them evades the cap.
  function createSourceReplyMessageTool(config: Record<string, unknown>) {
    return createMessageTool({
      currentChannelProvider: "reef",
      currentChannelId: "reef:operator",
      // The current source's real target is the peer the conv ref also points at.
      currentMessagingTarget: peerTarget,
      agentAccountId: "default",
      agentSessionKey: sessionKey,
      runId,
      sourceReplyDeliveryMode: "message_tool_only",
      config: config as never,
      runMessageAction: (async () =>
        ({
          kind: "send",
          action: "send",
          channel: "reef",
          to: peerTarget,
          handledBy: "plugin",
          payload: {},
          dryRun: false,
        }) satisfies MessageActionResult) as never,
      resolveCommandSecretRefsViaGateway: (async ({ config: cfg }: { config: unknown }) => ({
        resolvedConfig: cfg,
        diagnostics: [],
      })) as never,
      getScopedChannelsCommandSecretTargets: (() => ({ targetIds: new Set<string>() })) as never,
    });
  }

  it("caps a conversations_send that follows a no-target source reply to the same peer", async () => {
    const config = { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } };
    const deps = createDeps();
    const messageTool = createSourceReplyMessageTool(config);
    const conversationTool = createConversationsSendTool(
      { agentId: "main", agentSessionKey: sessionKey, runId, config: config as never },
      deps,
    );

    // 1st send (message tool, NO explicit target): resolves to the current source's
    // concrete target and consumes the single-send budget for that peer.
    const first = await messageTool.execute("msg-source", { action: "send", message: "hello" });
    expect(first.details).not.toMatchObject({ status: "suppressed" });

    // 2nd send (conversations_send, same peer): blocked by the shared cap of 1, so the
    // no-target source key and the conv-ref key must be one and the same slot.
    const blocked = await conversationTool.execute("conv-1", {
      conversationRef: conversation.conversationRef,
      message: "hello again",
    });
    // conversations_send returns the tool-local suppressed shape; the block reason
    // rides in both the text content and the declared turnSendNotice details field.
    expect(blocked.details).toEqual({
      status: "suppressed",
      conversationRef: conversation.conversationRef,
      channel: "reef",
      turnSendNotice: expect.stringContaining("configured limit of 1 message(s)"),
    });
    // The blocked send never reached the Gateway.
    expect(deps.callGatewayMock).not.toHaveBeenCalled();
  });
});

// Drives the REAL Code Mode bridge projection (runBridgeRequest -> callValue ->
// `called.result.details`) with a real ToolSearchRuntime and catalog registration,
// asserting directly on the value a Code Mode guest receives — not the tool envelope.
// Presentation content is dropped by the projection, so the send-budget guidance
// only survives if it rides in the declared details.turnSendNotice field.
describe("Code Mode bridge projects the send-budget notice into the guest value", () => {
  const sessionKey = "agent:main:reef:direct:operator";
  const runId = "run-bridge-1";
  const peerTarget = conversation.target;
  let bridgeSeq = 0;

  function buildRuntime(tools: Parameters<typeof registerHeadlessToolSearchCatalog>[0]["tools"]) {
    const catalogRef: ToolSearchCatalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools });
    const runtime = new ToolSearchRuntime(
      { catalogRef },
      resolveToolSearchConfig({ tools: { toolSearch: { enabled: true, mode: "code" } } } as never),
    );
    return { catalogRef, runtime };
  }

  // Resolve the callable name from the runtime's own catalog so the binding id the
  // bridge dispatches (callExactId) is exactly the registered entry's id.
  async function projectViaBridge(params: {
    runtime: ToolSearchRuntime;
    catalogRef: ToolSearchCatalogRef;
    toolName: string;
    input: unknown;
  }): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    const projection = createCodeModeCatalogProjection(
      (params.catalogRef.current?.entries ?? []).map(compactToolSearchCatalogEntry),
    );
    const binding = projection.bindings.find((entry) => entry.name === params.toolName);
    if (!binding) {
      throw new Error(`missing catalog binding for ${params.toolName}`);
    }
    // The bridge now settles the guest value through a reply lease and returns
    // void; the projected details are read back via reply.take()/json.
    const id = `bridge-${(bridgeSeq += 1)}`;
    const inbox = new CodeModeProgramDataInbox(resolveCodeModeConfig({}));
    const reply = inbox.createReply(id);
    try {
      await runBridgeRequest({
        runtime: params.runtime,
        catalogProjection: projection,
        namespaceRuntime: {} as never,
        parentToolCallId: "bridge-send-budget",
        codeModeRunId: "cm-send-budget",
        reply,
        remainingMs: 60_000,
        ctx: { catalogRef: params.catalogRef },
        request: {
          id,
          method: "callValue",
          args: [binding.callableName, params.input],
        },
      });
      const settled = reply.take();
      const value = JSON.parse(settled.json) as unknown;
      return settled.ok
        ? { ok: true, value }
        : { ok: false, error: typeof value === "string" ? value : JSON.stringify(value) };
    } finally {
      reply.release();
      inbox.close();
    }
  }

  function expectProjectedValue(settled: Awaited<ReturnType<typeof projectViaBridge>>) {
    expect(settled.ok).toBe(true);
    if (!settled.ok) {
      throw new Error(settled.error);
    }
    // The guest value is the projected details only; the tool's presentation content
    // (the text node carrying the same notice) must never reach the guest.
    expect(settled.value).not.toHaveProperty("content");
    return settled.value as Record<string, unknown>;
  }

  function createBridgeMessageTool(
    config: Record<string, unknown>,
    options: { toolResult?: AgentToolResult<unknown> } = {},
  ) {
    return createMessageTool({
      currentChannelProvider: "reef",
      currentChannelId: "reef:operator",
      agentAccountId: "default",
      agentSessionKey: sessionKey,
      runId,
      sourceReplyDeliveryMode: "message_tool_only",
      config: config as never,
      runMessageAction: (async () =>
        ({
          kind: "send",
          action: "send",
          channel: "reef",
          to: peerTarget,
          handledBy: "plugin",
          payload: {},
          ...(options.toolResult ? { toolResult: options.toolResult } : {}),
          dryRun: false,
        }) satisfies MessageActionResult) as never,
      resolveCommandSecretRefsViaGateway: (async ({ config: cfg }: { config: unknown }) => ({
        resolvedConfig: cfg,
        diagnostics: [],
      })) as never,
      getScopedChannelsCommandSecretTargets: (() => ({ targetIds: new Set<string>() })) as never,
    });
  }

  it("projects the conversations_send nudge into the guest value on the second send", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(
      { agentId: "main", agentSessionKey: sessionKey, runId, config: {} },
      deps,
    );
    const { catalogRef, runtime } = buildRuntime([tool]);
    const input = { conversationRef: conversation.conversationRef, message: "hi" };

    const first = expectProjectedValue(
      await projectViaBridge({ runtime, catalogRef, toolName: "conversations_send", input }),
    );
    expect(first).not.toHaveProperty("turnSendNotice");

    const second = expectProjectedValue(
      await projectViaBridge({ runtime, catalogRef, toolName: "conversations_send", input }),
    );
    expect(second).toMatchObject({
      status: "sent",
      turnSendNotice: expect.stringContaining("already sent 2 messages"),
    });
  });

  it("projects the conversations_send cap block into the guest value", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(
      {
        agentId: "main",
        agentSessionKey: sessionKey,
        runId,
        config: { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } },
      },
      deps,
    );
    const { catalogRef, runtime } = buildRuntime([tool]);
    const input = { conversationRef: conversation.conversationRef, message: "hi" };

    await projectViaBridge({ runtime, catalogRef, toolName: "conversations_send", input });
    const capped = expectProjectedValue(
      await projectViaBridge({ runtime, catalogRef, toolName: "conversations_send", input }),
    );
    expect(capped).toMatchObject({
      status: "suppressed",
      turnSendNotice: expect.stringContaining("Finalize your reply"),
    });
  });

  it("projects the message-tool nudge into the guest value on the second send", async () => {
    const messageTool = createBridgeMessageTool({});
    const { catalogRef, runtime } = buildRuntime([messageTool]);
    const input = { action: "send", channel: "reef", to: peerTarget, message: "hi" };

    const first = expectProjectedValue(
      await projectViaBridge({ runtime, catalogRef, toolName: "message", input }),
    );
    expect(first).not.toHaveProperty("turnSendNotice");

    const second = expectProjectedValue(
      await projectViaBridge({ runtime, catalogRef, toolName: "message", input }),
    );
    expect(second).toMatchObject({
      turnSendNotice: expect.stringContaining("already sent 2 messages"),
    });
  });

  it("projects the whole details-less plugin result rather than undefined when a nudge is appended", async () => {
    // A plugin toolResult with content but no `details` key at all. The SDK helpers
    // always set details, but a plugin returning a raw envelope need not, and the cast
    // deliberately models that details-less runtime shape. The notice-append path must
    // not materialize `details: undefined` on such an envelope: Code Mode's projection
    // discriminates on presence (`"details" in result`), so an added undefined details
    // key would surface to the guest as `undefined` instead of the real envelope.
    const detailsLessToolResult = {
      content: [{ type: "text" as const, text: "delivered via plugin" }],
    } as AgentToolResult<unknown>;
    const messageTool = createBridgeMessageTool({}, { toolResult: detailsLessToolResult });
    const { catalogRef, runtime } = buildRuntime([messageTool]);
    const input = { action: "send", channel: "reef", to: peerTarget, message: "hi" };

    // First send: no nudge. With no details to project, the guest receives the whole
    // envelope, so the value is defined.
    const first = await projectViaBridge({ runtime, catalogRef, toolName: "message", input });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error(first.error);
    }
    expect(first.value).toBeDefined();

    // Second send: a turn-send nudge is appended. Before the fix this materialized
    // `details: undefined` and the guest saw `undefined`; now the details-less
    // envelope is preserved and carries the appended nudge in its content.
    const second = await projectViaBridge({ runtime, catalogRef, toolName: "message", input });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error(second.error);
    }
    expect(second.value).toBeDefined();
    expect(second.value).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("already sent 2 messages"),
        }),
      ]),
    });
  });
});
