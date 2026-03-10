import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  describeIMessageEchoDropLog,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";

describe("resolveIMessageInboundDecision is_from_me", () => {
  const cfg = {} as OpenClawConfig;

  it("drops messages with is_from_me=true", () => {
    const decision = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 1,
        sender: "+15555550123",
        text: "Hello",
        is_from_me: true,
        is_group: false,
      },
      opts: undefined,
      messageText: "Hello",
      bodyText: "Hello",
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

    expect(decision).toEqual({ kind: "drop", reason: "from me" });
  });
});

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

  it("drops self-echo via account-global outbound scope when conversation scope mismatches", () => {
    // Simulates: bot sent "Hi there" to alice, but echo comes back with sender=bot_handle.
    // Conversation scope won't match, but the global _outbound_ scope catches it.
    const echoHas = vi.fn((scope: string, lookup: { text?: string; messageId?: string }) => {
      // Conversation scope uses bot's own handle — doesn't match the original target scope
      if (scope === "default:imessage:bot@icloud.com") {
        return false;
      }
      // Account-global outbound scope matches
      if (scope === "default:_outbound_" && lookup.text === "Hi there") {
        return true;
      }
      return false;
    });

    const decision = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 99,
        sender: "bot@icloud.com",
        text: "Hi there",
        is_from_me: false, // not set by daemon in this scenario
        is_group: false,
      },
      opts: undefined,
      messageText: "Hi there",
      bodyText: "Hi there",
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
    // Should have checked both conversation scope and global scope
    expect(echoHas).toHaveBeenCalledWith(
      "default:imessage:bot@icloud.com",
      expect.objectContaining({ text: "Hi there" }),
    );
    expect(echoHas).toHaveBeenCalledWith(
      "default:_outbound_",
      expect.objectContaining({ text: "Hi there" }),
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
