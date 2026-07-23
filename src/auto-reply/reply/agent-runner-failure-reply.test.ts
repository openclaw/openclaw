import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  buildEmptyInteractiveReplyPayload,
  buildSessionsYieldAckReplyPayload,
} from "./agent-runner-failure-reply.js";

const EMPTY_INTERACTIVE_REPLY_TEXT =
  "I finished the turn, but it did not produce a visible reply. Please try again, or start a new session if this keeps happening.";

describe("buildEmptyInteractiveReplyPayload", () => {
  const baseParams = {
    isInteractive: true,
    isMessageToolOnly: false,
    hasPendingContinuation: false,
    hasExplicitSilentReply: false,
    hasCommittedDelivery: false,
    sessionCtx: {
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
    },
  } as const;

  it("preserves the default silent policy in group conversations", () => {
    const payload = buildEmptyInteractiveReplyPayload(baseParams);

    expect(payload?.text).toBe(SILENT_REPLY_TOKEN);
    expect(payload?.isError).toBeUndefined();
  });

  it("surfaces the fallback when group silence is explicitly disallowed", () => {
    expect(
      buildEmptyInteractiveReplyPayload({
        ...baseParams,
        cfg: { agents: { defaults: { silentReply: { group: "disallow" } } } },
      }),
    ).toMatchObject({ text: EMPTY_INTERACTIVE_REPLY_TEXT, isError: true });
  });
});

describe("buildSessionsYieldAckReplyPayload (#107788)", () => {
  const baseParams = {
    yielded: true,
    yieldMessage: "Research started — I'll send the results shortly.",
    isInteractive: true,
    isMessageToolOnly: false,
    hasExplicitSilentReply: false,
    hasCommittedDelivery: false,
  } as const;

  it("delivers the yield acknowledgment for an interactive yielded turn", () => {
    expect(buildSessionsYieldAckReplyPayload(baseParams)).toEqual({
      text: "Research started — I'll send the results shortly.",
    });
  });

  it("trims whitespace and drops empty or missing messages", () => {
    expect(
      buildSessionsYieldAckReplyPayload({ ...baseParams, yieldMessage: "  ack  " })?.text,
    ).toBe("ack");
    expect(
      buildSessionsYieldAckReplyPayload({ ...baseParams, yieldMessage: "   " }),
    ).toBeUndefined();
    expect(
      buildSessionsYieldAckReplyPayload({ ...baseParams, yieldMessage: undefined }),
    ).toBeUndefined();
  });

  it("stays silent when the turn did not yield", () => {
    expect(buildSessionsYieldAckReplyPayload({ ...baseParams, yielded: false })).toBeUndefined();
  });

  it("keeps heartbeat turns silent", () => {
    expect(buildSessionsYieldAckReplyPayload({ ...baseParams, isHeartbeat: true })).toBeUndefined();
  });

  it("keeps non-interactive turns silent (internal provenance, e.g. subagent runs)", () => {
    expect(
      buildSessionsYieldAckReplyPayload({ ...baseParams, isInteractive: false }),
    ).toBeUndefined();
  });

  it("respects silent-expected and message-tool-only delivery modes", () => {
    expect(
      buildSessionsYieldAckReplyPayload({ ...baseParams, silentExpected: true }),
    ).toBeUndefined();
    expect(
      buildSessionsYieldAckReplyPayload({ ...baseParams, isMessageToolOnly: true }),
    ).toBeUndefined();
  });

  it("never double-acknowledges a turn that already delivered visibly", () => {
    expect(
      buildSessionsYieldAckReplyPayload({ ...baseParams, hasCommittedDelivery: true }),
    ).toBeUndefined();
    expect(
      buildSessionsYieldAckReplyPayload({ ...baseParams, hasExplicitSilentReply: true }),
    ).toBeUndefined();
  });
});
