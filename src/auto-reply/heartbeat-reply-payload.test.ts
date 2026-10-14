// Heartbeat reply payload selector tests.
import { describe, expect, it } from "vitest";
import { classifyHeartbeatAgentOutcome } from "../infra/heartbeat-delivery-normalization.js";
import {
  resolveHeartbeatReplyPayload,
  resolveHeartbeatTerminalToolFailure,
} from "./heartbeat-reply-payload.js";
import { setReplyPayloadMetadata } from "./reply-payload.js";
import type { ReplyPayload } from "./types.js";

describe("resolveHeartbeatReplyPayload", () => {
  it.each(["Spoken heartbeat.", "   "])(
    "selects and classifies speech-only heartbeat content: %j",
    (text) => {
      const payload = setReplyPayloadMetadata({ text: "" }, { tts: { tagged: true, text } });
      const selected = resolveHeartbeatReplyPayload([
        payload,
        { text: "private", isReasoning: true },
      ]);
      expect(selected).toBe(text.trim() ? payload : undefined);
      const outcome = classifyHeartbeatAgentOutcome({
        agentRun: { agentRunFailed: false, replyPayload: selected },
        useHeartbeatFailureCopy: false,
        hasRelayableExecCompletion: false,
        suppressUnmarkedSourceReplies: false,
        responsePrefix: undefined,
        ackMaxChars: 300,
      });
      expect(outcome).toMatchObject(
        text.trim()
          ? { kind: "delivery", replyPayload: payload, normalized: { text: "" } }
          : { kind: "ack", eventStatus: "ok-empty" },
      );
    },
  );
  it("returns a single non-array payload unchanged", () => {
    const payload: ReplyPayload = { text: "HEARTBEAT_OK" };
    expect(resolveHeartbeatReplyPayload(payload)).toBe(payload);
  });

  it("returns undefined for undefined input", () => {
    expect(resolveHeartbeatReplyPayload(undefined)).toBeUndefined();
    expect(resolveHeartbeatTerminalToolFailure(undefined)).toBeUndefined();
  });

  it("resolves terminal tool-failure metadata independently of payload order", () => {
    const heartbeat = setReplyPayloadMetadata(
      { text: "HEARTBEAT_OK" },
      { heartbeatTerminalToolFailure: { toolName: "message" } },
    );
    const warning: ReplyPayload = { text: "Message failed", isError: true };

    expect(resolveHeartbeatTerminalToolFailure([heartbeat, warning])).toEqual({
      toolName: "message",
    });
  });

  it("skips a trailing reasoning payload and returns the assistant answer", () => {
    const answer: ReplyPayload = { text: "HEARTBEAT_OK" };
    const reasoning: ReplyPayload = {
      text: "The message is an OpenClaw heartbeat poll. I should check recent chat...",
      isReasoning: true,
    };
    expect(resolveHeartbeatReplyPayload([answer, reasoning])).toBe(answer);
  });

  it("returns undefined for a scalar reasoning payload", () => {
    const reasoning: ReplyPayload = {
      text: "Considering whether the heartbeat needs a reply...",
      isReasoning: true,
    };
    expect(resolveHeartbeatReplyPayload(reasoning)).toBeUndefined();
  });
});
