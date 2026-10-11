// Per-turn send budget account identity (#119992 / PR #120491). An omitted account must
// key the budget on the account delivery actually uses, so it shares one slot with an
// explicit send and with conversations_send to the same peer. Drives the real
// runMessageAction -> outbound adapter path; the adapter records the delivering account.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createConversationsSendTool } from "./conversation-tools.js";
import { createMessageTool } from "./message-tool-execution.js";
import { createChannelPlugin } from "./message-tool.test-support.js";
import {
  buildTurnSendLedgerSessionKey,
  buildTurnSendTargetKey,
  peekTurnSendCount,
  resetTurnSendLedgerForTest,
} from "./turn-send-ledger.js";

vi.mock("../../channels/plugins/bundled.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/bundled.js")>()),
  getBundledChannelPlugin: vi.fn(() => undefined),
  getBundledChannelSetupPlugin: vi.fn(() => undefined),
}));

vi.mock("../../channels/plugins/message-tool-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/message-tool-api.js")>()),
  resolveBundledChannelMessageToolDiscoveryAdapter: () => ({
    describeMessageTool: () => ({ actions: ["send"], capabilities: [] }),
  }),
}));

const PEER = "+15550009999";
const SESSION_KEY = "agent:test:cron:budget-account";
const RUN_ID = "run-budget-account";
const LEDGER_SESSION_KEY = buildTurnSendLedgerSessionKey("test", SESSION_KEY)!;

type Delivery = { accountId: string | null | undefined; text: string };

let deliveries: Delivery[];

// "work" is the configured named default and deliberately not the first listed account,
// so a key that folded an omitted account to "default" or to the first account would split.
function registerAccountsPlugin() {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "imessage",
        source: "test",
        plugin: createChannelPlugin({
          id: "imessage",
          actions: ["send"],
          config: {
            listAccountIds: () => ["primary", "work", "secondary"],
            defaultAccountId: () => "work",
          },
          outbound: {
            deliveryMode: "direct",
            sendText: async (ctx) => {
              deliveries.push({ accountId: ctx.accountId, text: ctx.text });
              return {
                channel: "imessage" as ChannelPlugin["id"],
                messageId: `m${deliveries.length}`,
              };
            },
          },
        }),
      },
    ]),
  );
}

function createConfig(extra: Record<string, unknown> = {}) {
  return {
    channels: { imessage: { enabled: true } },
    tools: { message: { maxMessagesPerTurnPerTarget: 1 } },
    ...extra,
  };
}

// Source-less (cron/CLI shaped): no current channel and no agent account, so only the
// routing owner's precedence can name the delivering account.
function createSourcelessMessageTool(config: Record<string, unknown>, sessionKey = SESSION_KEY) {
  return createMessageTool({
    agentId: "test",
    agentSessionKey: sessionKey,
    runId: RUN_ID,
    config: config as never,
    resolveCommandSecretRefsViaGateway: (async ({ config: cfg }: { config: unknown }) => ({
      resolvedConfig: cfg,
      diagnostics: [],
    })) as never,
    getScopedChannelsCommandSecretTargets: (() => ({ targetIds: new Set<string>() })) as never,
  });
}

function sendArgs(message: string, accountId?: string) {
  return {
    action: "send",
    channel: "imessage",
    target: PEER,
    message,
    ...(accountId ? { accountId } : {}),
  };
}

function ledgerCount(accountId: string, sessionKey = LEDGER_SESSION_KEY): number {
  return peekTurnSendCount({
    sessionKey,
    runId: RUN_ID,
    targetKey: buildTurnSendTargetKey({ channel: "imessage", accountId, target: PEER }),
  });
}

const EXHAUSTED = { status: "suppressed", reason: "turn_send_budget_exhausted" };

beforeEach(() => {
  deliveries = [];
  registerAccountsPlugin();
});

afterEach(() => {
  resetTurnSendLedgerForTest();
  resetPluginRuntimeStateForTest();
});

describe("per-turn send budget effective account", () => {
  it("keys a source-less omitted-account send on the channel's named default account", async () => {
    const tool = createSourcelessMessageTool(createConfig());

    const first = await tool.execute("acct-1", sendArgs("first"));
    expect(first.details).not.toMatchObject({ status: "suppressed" });
    expect(deliveries).toEqual([{ accountId: "work", text: "first" }]);
    expect(ledgerCount("work")).toBe(1);

    const explicit = await tool.execute("acct-2", sendArgs("second", "work"));
    expect(explicit.details).toMatchObject(EXHAUSTED);
    expect(deliveries).toHaveLength(1);
  });

  it("keys an omitted-account send on the agent's target binding", async () => {
    const tool = createSourcelessMessageTool(
      createConfig({
        bindings: [
          {
            agentId: "test",
            match: {
              channel: "imessage",
              accountId: "secondary",
              peer: { kind: "direct", id: PEER },
            },
          },
        ],
      }),
    );

    await tool.execute("bind-1", sendArgs("first"));
    expect(deliveries).toEqual([{ accountId: "secondary", text: "first" }]);
    expect(ledgerCount("secondary")).toBe(1);

    const explicit = await tool.execute("bind-2", sendArgs("second", "secondary"));
    expect(explicit.details).toMatchObject(EXHAUSTED);
    expect(deliveries).toHaveLength(1);
  });

  it("keeps a distinct real account to the same peer in its own slot", async () => {
    const tool = createSourcelessMessageTool(createConfig());

    await tool.execute("distinct-1", sendArgs("first"));
    const other = await tool.execute("distinct-2", sendArgs("second", "primary"));
    expect(other.details).not.toMatchObject({ status: "suppressed" });
    expect(deliveries.map((delivery) => delivery.accountId)).toEqual(["work", "primary"]);
    expect(ledgerCount("work")).toBe(1);
    expect(ledgerCount("primary")).toBe(1);
  });

  it("shares the slot with a conversations_send to the same peer on the default account", async () => {
    const config = createConfig();
    const messageTool = createSourcelessMessageTool(config);
    const callGateway = vi.fn();
    const conversationTool = createConversationsSendTool(
      { agentId: "test", agentSessionKey: SESSION_KEY, runId: RUN_ID, config: config as never },
      {
        callGateway: callGateway as never,
        readConversation: (async () => ({
          conversationRef: "conv_0123456789abcdef0123456789abcdef",
          channel: "imessage",
          accountId: "work",
          kind: "direct",
          peerId: PEER,
          target: PEER,
          firstSeenAt: 100,
          lastSeenAt: 200,
        })) as never,
      },
    );

    await messageTool.execute("cross-1", sendArgs("first"));
    expect(deliveries).toHaveLength(1);

    const blocked = await conversationTool.execute("cross-2", {
      conversationRef: "conv_0123456789abcdef0123456789abcdef",
      message: "second",
    });
    expect(blocked.details).toMatchObject({ status: "suppressed" });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("keys main-session aliases on the canonical slot the CLI loopback grant uses", async () => {
    // A native candidate may run under the raw "main" alias while a CLI candidate of the
    // same turn writes under the canonical agent:<id>:main grant scope.
    const config = createConfig();
    const canonicalLedgerKey = buildTurnSendLedgerSessionKey("test", "agent:test:main")!;
    const callGateway = vi.fn();
    const aliasConversationTool = createConversationsSendTool(
      { agentId: "test", agentSessionKey: "main", runId: RUN_ID, config: config as never },
      {
        callGateway: callGateway as never,
        readConversation: (async () => ({
          conversationRef: "conv_0123456789abcdef0123456789abcdef",
          channel: "imessage",
          accountId: "work",
          kind: "direct",
          peerId: PEER,
          target: PEER,
          firstSeenAt: 100,
          lastSeenAt: 200,
        })) as never,
      },
    );

    await createSourcelessMessageTool(config, "agent:test:main").execute(
      "alias-1",
      sendArgs("first"),
    );
    expect(ledgerCount("work", canonicalLedgerKey)).toBe(1);

    const aliasMessage = await createSourcelessMessageTool(config, "main").execute(
      "alias-2",
      sendArgs("second"),
    );
    expect(aliasMessage.details).toMatchObject(EXHAUSTED);
    const aliasConversation = await aliasConversationTool.execute("alias-3", {
      conversationRef: "conv_0123456789abcdef0123456789abcdef",
      message: "third",
    });
    expect(aliasConversation.details).toMatchObject({ status: "suppressed" });
    expect(callGateway).not.toHaveBeenCalled();
    expect(deliveries).toHaveLength(1);
  });
});
