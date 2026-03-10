import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  describeIMessageEchoDropLog,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";

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

describe("resolveIMessageInboundDecision neverReply gating", () => {
  it("drops group messages with reason neverReply when neverReply is true", () => {
    const cfg = {
      channels: {
        imessage: {
          neverReply: true,
        },
      },
    } as unknown as OpenClawConfig;

    const groupHistories = new Map();

    const decision = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 200,
        sender: "+15555550199",
        text: "hello from the group",
        is_from_me: false,
        is_group: true,
        chat_id: 77,
      },
      opts: undefined,
      messageText: "hello from the group",
      bodyText: "hello from the group",
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 5,
      groupHistories,
      echoCache: undefined,
      logVerbose: undefined,
    });

    expect(decision).toEqual({ kind: "drop", reason: "neverReply" });
  });

  it("records pending history entry when neverReply drops a group message", () => {
    const cfg = {
      channels: {
        imessage: {
          neverReply: true,
        },
      },
    } as unknown as OpenClawConfig;

    const groupHistories = new Map() as Map<
      string,
      import("../../auto-reply/reply/history.js").HistoryEntry[]
    >;

    resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 201,
        sender: "+15555550199",
        text: "context message",
        is_from_me: false,
        is_group: true,
        chat_id: 77,
      },
      opts: undefined,
      messageText: "context message",
      bodyText: "context message",
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 5,
      groupHistories,
      echoCache: undefined,
      logVerbose: undefined,
    });

    const entries = groupHistories.get("77");
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(1);
    expect(entries![0]).toMatchObject({
      sender: "+15555550199",
      body: "context message",
    });
  });

  it("does not drop DM messages when neverReply is true", () => {
    const cfg = {
      channels: {
        imessage: {
          neverReply: true,
        },
      },
    } as unknown as OpenClawConfig;

    const decision = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 202,
        sender: "+15555550199",
        text: "hello DM",
        is_from_me: false,
        is_group: false,
      },
      opts: undefined,
      messageText: "hello DM",
      bodyText: "hello DM",
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      logVerbose: undefined,
    });

    expect(decision.kind).toBe("dispatch");
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
