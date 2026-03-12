import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { sanitizeTerminalText } from "../../terminal/safe-text.js";
import {
  describeIMessageEchoDropLog,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";
import { createSelfChatCache } from "./self-chat-cache.js";

describe("resolveIMessageInboundDecision echo detection", () => {
  const cfg = {} as OpenClawConfig;

  it("drops inbound messages when outbound message id matches echo cache", () => {
    const echoHas = vi.fn((_scope: string, lookup: { text?: string; messageId?: string }) => {
      return lookup.messageId === "42";
    });

    const decision = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 42,
        sender: "+15555550123",
        text: "Reasoning:\n_step_",
        is_from_me: false,
        is_group: false,
      },
      opts: undefined,
      messageText: "Reasoning:\n_step_",
      bodyText: "Reasoning:\n_step_",
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: { has: echoHas },
      logVerbose: undefined,
    });

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
    expect(echoHas).toHaveBeenCalledWith(
      "default:imessage:+15555550123",
      expect.objectContaining({
        text: "Reasoning:\n_step_",
        messageId: "42",
      }),
    );
  });

  it("drops reflected self-chat duplicates after seeing the from-me copy", () => {
    const selfChatCache = createSelfChatCache();
    const createdAt = "2026-03-02T20:58:10.649Z";

    expect(
      resolveIMessageInboundDecision({
        cfg,
        accountId: "default",
        message: {
          id: 9641,
          sender: "+15555550123",
          text: "Do you want to report this issue?",
          created_at: createdAt,
          is_from_me: true,
          is_group: false,
        },
        opts: undefined,
        messageText: "Do you want to report this issue?",
        bodyText: "Do you want to report this issue?",
        allowFrom: [],
        groupAllowFrom: [],
        groupPolicy: "open",
        dmPolicy: "open",
        storeAllowFrom: [],
        historyLimit: 0,
        groupHistories: new Map(),
        echoCache: undefined,
        selfChatCache,
        logVerbose: undefined,
      }),
    ).toEqual({ kind: "drop", reason: "from me" });

    expect(
      resolveIMessageInboundDecision({
        cfg,
        accountId: "default",
        message: {
          id: 9642,
          sender: "+15555550123",
          text: "Do you want to report this issue?",
          created_at: createdAt,
          is_from_me: false,
          is_group: false,
        },
        opts: undefined,
        messageText: "Do you want to report this issue?",
        bodyText: "Do you want to report this issue?",
        allowFrom: [],
        groupAllowFrom: [],
        groupPolicy: "open",
        dmPolicy: "open",
        storeAllowFrom: [],
        historyLimit: 0,
        groupHistories: new Map(),
        echoCache: undefined,
        selfChatCache,
        logVerbose: undefined,
      }),
    ).toEqual({ kind: "drop", reason: "self-chat echo" });
  });

  it("does not drop same-text messages when created_at differs", () => {
    const selfChatCache = createSelfChatCache();

    resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 9641,
        sender: "+15555550123",
        text: "ok",
        created_at: "2026-03-02T20:58:10.649Z",
        is_from_me: true,
        is_group: false,
      },
      opts: undefined,
      messageText: "ok",
      bodyText: "ok",
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      selfChatCache,
      logVerbose: undefined,
    });

    const decision = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 9642,
        sender: "+15555550123",
        text: "ok",
        created_at: "2026-03-02T20:58:11.649Z",
        is_from_me: false,
        is_group: false,
      },
      opts: undefined,
      messageText: "ok",
      bodyText: "ok",
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      selfChatCache,
      logVerbose: undefined,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("keeps self-chat cache scoped to configured group threads", () => {
    const selfChatCache = createSelfChatCache();
    const groupedCfg = {
      channels: {
        imessage: {
          groups: {
            "123": {},
            "456": {},
          },
        },
      },
    } as OpenClawConfig;
    const createdAt = "2026-03-02T20:58:10.649Z";

    expect(
      resolveIMessageInboundDecision({
        cfg: groupedCfg,
        accountId: "default",
        message: {
          id: 9701,
          chat_id: 123,
          sender: "+15555550123",
          text: "same text",
          created_at: createdAt,
          is_from_me: true,
          is_group: false,
        },
        opts: undefined,
        messageText: "same text",
        bodyText: "same text",
        allowFrom: [],
        groupAllowFrom: [],
        groupPolicy: "open",
        dmPolicy: "open",
        storeAllowFrom: [],
        historyLimit: 0,
        groupHistories: new Map(),
        echoCache: undefined,
        selfChatCache,
        logVerbose: undefined,
      }),
    ).toEqual({ kind: "drop", reason: "from me" });

    const decision = resolveIMessageInboundDecision({
      cfg: groupedCfg,
      accountId: "default",
      message: {
        id: 9702,
        chat_id: 456,
        sender: "+15555550123",
        text: "same text",
        created_at: createdAt,
        is_from_me: false,
        is_group: false,
      },
      opts: undefined,
      messageText: "same text",
      bodyText: "same text",
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      selfChatCache,
      logVerbose: undefined,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("does not drop other participants in the same group thread", () => {
    const selfChatCache = createSelfChatCache();
    const createdAt = "2026-03-02T20:58:10.649Z";

    expect(
      resolveIMessageInboundDecision({
        cfg,
        accountId: "default",
        message: {
          id: 9751,
          chat_id: 123,
          sender: "+15555550123",
          text: "same text",
          created_at: createdAt,
          is_from_me: true,
          is_group: true,
        },
        opts: undefined,
        messageText: "same text",
        bodyText: "same text",
        allowFrom: [],
        groupAllowFrom: [],
        groupPolicy: "open",
        dmPolicy: "open",
        storeAllowFrom: [],
        historyLimit: 0,
        groupHistories: new Map(),
        echoCache: undefined,
        selfChatCache,
        logVerbose: undefined,
      }),
    ).toEqual({ kind: "drop", reason: "from me" });

    const decision = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 9752,
        chat_id: 123,
        sender: "+15555550999",
        text: "same text",
        created_at: createdAt,
        is_from_me: false,
        is_group: true,
      },
      opts: undefined,
      messageText: "same text",
      bodyText: "same text",
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      selfChatCache,
      logVerbose: undefined,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("sanitizes reflected duplicate previews before logging", () => {
    const selfChatCache = createSelfChatCache();
    const logVerbose = vi.fn();
    const createdAt = "2026-03-02T20:58:10.649Z";
    const bodyText = "line-1\nline-2\t\u001b[31mred";

    resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 9801,
        sender: "+15555550123",
        text: bodyText,
        created_at: createdAt,
        is_from_me: true,
        is_group: false,
      },
      opts: undefined,
      messageText: bodyText,
      bodyText,
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      selfChatCache,
      logVerbose,
    });

    resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 9802,
        sender: "+15555550123",
        text: bodyText,
        created_at: createdAt,
        is_from_me: false,
        is_group: false,
      },
      opts: undefined,
      messageText: bodyText,
      bodyText,
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      selfChatCache,
      logVerbose,
    });

    expect(logVerbose).toHaveBeenCalledWith(
      `imessage: dropping self-chat reflected duplicate: "${sanitizeTerminalText(bodyText)}"`,
    );
  });
});

describe("describeIMessageEchoDropLog", () => {
  it("includes message id when available", () => {
    expect(
      describeIMessageEchoDropLog({
        messageText: "Reasoning:\n_step_",
        messageId: "abc-123",
      }),
    ).toContain("id=abc-123");
  });
});

describe("resolveIMessageInboundDecision command auth", () => {
  const cfg = {} as OpenClawConfig;
  const resolveDmCommandDecision = (params: { messageId: number; storeAllowFrom: string[] }) =>
    resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: params.messageId,
        sender: "+15555550123",
        text: "/status",
        is_from_me: false,
        is_group: false,
      },
      opts: undefined,
      messageText: "/status",
      bodyText: "/status",
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: params.storeAllowFrom,
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      logVerbose: undefined,
    });

  it("does not auto-authorize DM commands in open mode without allowlists", () => {
    const decision = resolveDmCommandDecision({
      messageId: 100,
      storeAllowFrom: [],
    });

    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.commandAuthorized).toBe(false);
  });

  it("authorizes DM commands for senders in pairing-store allowlist", () => {
    const decision = resolveDmCommandDecision({
      messageId: 101,
      storeAllowFrom: ["+15555550123"],
    });

    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.commandAuthorized).toBe(true);
  });
});
