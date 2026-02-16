import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { buildMentionConfig } from "./mentions.js";
import { applyGroupGating } from "./monitor/group-gating.js";
import { buildInboundLine, formatReplyContext } from "./monitor/message-line.js";

let sessionDir: string | undefined;
let sessionStorePath: string;

beforeEach(async () => {
  sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-group-gating-"));
  sessionStorePath = path.join(sessionDir, "sessions.json");
  await fs.writeFile(sessionStorePath, "{}");
});

afterEach(async () => {
  if (sessionDir) {
    await fs.rm(sessionDir, { recursive: true, force: true });
    sessionDir = undefined;
  }
});

const makeConfig = (overrides: Record<string, unknown>) =>
  ({
    channels: {
      whatsapp: {
        groupPolicy: "open",
        groups: { "*": { requireMention: true } },
      },
    },
    session: { store: sessionStorePath },
    ...overrides,
  }) as unknown as ReturnType<typeof import("../../config/config.js").loadConfig>;

function runGroupGating(params: {
  cfg: ReturnType<typeof import("../../config/config.js").loadConfig>;
  msg: Record<string, unknown>;
  conversationId?: string;
  agentId?: string;
}) {
  const groupHistories = new Map<string, unknown[]>();
  const conversationId = params.conversationId ?? "123@g.us";
  const agentId = params.agentId ?? "main";
  const sessionKey = `agent:${agentId}:whatsapp:group:${conversationId}`;
  const baseMentionConfig = buildMentionConfig(params.cfg, undefined);
  const result = applyGroupGating({
    cfg: params.cfg,
    // oxlint-disable-next-line typescript/no-explicit-any
    msg: params.msg as any,
    conversationId,
    groupHistoryKey: `whatsapp:default:group:${conversationId}`,
    agentId,
    sessionKey,
    baseMentionConfig,
    groupHistories,
    groupHistoryLimit: 10,
    groupMemberNames: new Map(),
    logVerbose: () => {},
    replyLogger: { debug: () => {} },
  });
  return { result, groupHistories };
}

function createGroupMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "g1",
    from: "123@g.us",
    conversationId: "123@g.us",
    chatId: "123@g.us",
    chatType: "group",
    to: "+2",
    body: "hello group",
    senderE164: "+111",
    senderName: "Alice",
    selfE164: "+999",
    sendComposing: async () => {},
    reply: async () => {},
    sendMedia: async () => {},
    ...overrides,
  };
}

describe("applyGroupGating", () => {
  it("treats reply-to-bot as implicit mention", () => {
    const cfg = makeConfig({});
    const { result } = runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "m1",
        to: "+15550000",
        accountId: "default",
        body: "following up",
        timestamp: Date.now(),
        selfJid: "15551234567@s.whatsapp.net",
        selfE164: "+15551234567",
        replyToId: "m0",
        replyToBody: "bot said hi",
        replyToSender: "+15551234567",
        replyToSenderJid: "15551234567@s.whatsapp.net",
        replyToSenderE164: "+15551234567",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("bypasses mention gating for owner /new in group chats", () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          allowFrom: ["+111"],
          groups: { "*": { requireMention: true } },
        },
      },
    });

    const { result } = runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "g-new",
        body: "/new",
        senderE164: "+111",
        senderName: "Owner",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("does not bypass mention gating for non-owner /new in group chats", () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          allowFrom: ["+999"],
          groups: { "*": { requireMention: true } },
        },
      },
    });

    const { result, groupHistories } = runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "g-new-unauth",
        body: "/new",
        senderE164: "+111",
        senderName: "NotOwner",
      }),
    });

    expect(result.shouldProcess).toBe(false);
    expect(groupHistories.get("whatsapp:default:group:123@g.us")?.length).toBe(1);
  });

  it("bypasses mention gating for owner /status in group chats", () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          allowFrom: ["+111"],
          groups: { "*": { requireMention: true } },
        },
      },
    });

    const { result } = runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "g-status",
        body: "/status",
        senderE164: "+111",
        senderName: "Owner",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("uses per-agent mention patterns for group gating (routing + mentionPatterns)", () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groups: { "*": { requireMention: true } },
        },
      },
      messages: {
        groupChat: { mentionPatterns: ["@global"] },
      },
      agents: {
        list: [
          {
            id: "work",
            groupChat: { mentionPatterns: ["@workbot"] },
          },
        ],
      },
      bindings: [
        {
          agentId: "work",
          match: {
            provider: "whatsapp",
            peer: { kind: "group", id: "123@g.us" },
          },
        },
      ],
    });

    const route = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      peer: { kind: "group", id: "123@g.us" },
    });
    expect(route.agentId).toBe("work");

    const { result: globalMention } = runGroupGating({
      cfg,
      agentId: route.agentId,
      msg: createGroupMessage({
        id: "g1",
        body: "@global ping",
        senderE164: "+111",
        senderName: "Alice",
      }),
    });
    expect(globalMention.shouldProcess).toBe(false);

    const { result: workMention } = runGroupGating({
      cfg,
      agentId: route.agentId,
      msg: createGroupMessage({
        id: "g2",
        body: "@workbot ping",
        senderE164: "+222",
        senderName: "Bob",
      }),
    });
    expect(workMention.shouldProcess).toBe(true);
  });

  it("allows group messages when whatsapp groups default disables mention gating", () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groups: { "*": { requireMention: false } },
        },
      },
      messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
    });

    const { result } = runGroupGating({
      cfg,
      msg: createGroupMessage(),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("blocks group messages when whatsapp groups is set without a wildcard", () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groups: {
            "999@g.us": { requireMention: false },
          },
        },
      },
    });

    const { result } = runGroupGating({
      cfg,
      msg: createGroupMessage({
        body: "@workbot ping",
        mentionedJids: ["999@s.whatsapp.net"],
        selfJid: "999@s.whatsapp.net",
      }),
    });

    expect(result.shouldProcess).toBe(false);
  });
});

describe("buildInboundLine", () => {
  it("prefixes group messages with sender", () => {
    const line = buildInboundLine({
      cfg: {
        agents: { defaults: { workspace: "/tmp/openclaw" } },
        channels: { whatsapp: { messagePrefix: "" } },
      } as never,
      agentId: "main",
      msg: createGroupMessage({
        to: "+15550009999",
        accountId: "default",
        body: "ping",
        timestamp: 1700000000000,
        senderJid: "111@s.whatsapp.net",
        senderE164: "+15550001111",
        senderName: "Bob",
      }) as never,
    });

    expect(line).toContain("Bob (+15550001111):");
    expect(line).toContain("ping");
  });

  it("includes reply-to context blocks when replyToBody is present", () => {
    const line = buildInboundLine({
      cfg: {
        agents: { defaults: { workspace: "/tmp/openclaw" } },
        channels: { whatsapp: { messagePrefix: "" } },
      } as never,
      agentId: "main",
      msg: {
        from: "+1555",
        to: "+1555",
        body: "hello",
        chatType: "direct",
        replyToId: "q1",
        replyToBody: "original",
        replyToSender: "+1999",
      } as never,
      envelope: { includeTimestamp: false },
    });

    expect(line).toContain("[Replying to +1999 id:q1]");
    expect(line).toContain("original");
    expect(line).toContain("[/Replying]");
  });

  it("applies the WhatsApp messagePrefix when configured", () => {
    const line = buildInboundLine({
      cfg: {
        agents: { defaults: { workspace: "/tmp/openclaw" } },
        channels: { whatsapp: { messagePrefix: "[PFX]" } },
      } as never,
      agentId: "main",
      msg: {
        from: "+1555",
        to: "+2666",
        body: "ping",
        chatType: "direct",
      } as never,
      envelope: { includeTimestamp: false },
    });

    expect(line).toContain("[PFX] ping");
  });
});

describe("formatReplyContext", () => {
  it("returns null when replyToBody is missing", () => {
    expect(formatReplyContext({} as never)).toBeNull();
  });
});
