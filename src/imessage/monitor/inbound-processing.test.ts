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

describe("resolveIMessageInboundDecision sender fallback", () => {
  const cfg = {} as OpenClawConfig;

  it("uses reply_to_sender when sender is missing", () => {
    const decision = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 77,
        sender: "",
        reply_to_sender: "+15555550001",
        text: "hello",
        is_from_me: false,
        is_group: false,
      },
      opts: undefined,
      messageText: "hello",
      bodyText: "hello",
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
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.sender).toBe("+15555550001");
  });

  it("uses single participant as group sender fallback when sender is missing", () => {
    const decision = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 78,
        sender: "",
        participants: ["+15555550002"],
        text: "group msg",
        chat_id: "chat-1",
        is_from_me: false,
        is_group: true,
      },
      opts: undefined,
      messageText: "group msg",
      bodyText: "group msg",
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
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.sender).toBe("+15555550002");
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
