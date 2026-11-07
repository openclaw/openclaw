import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverRequesterStallFallback } from "../../agents/subagents/announce/subagent-announce.requester-settle-fallback.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { loadTranscriptEvents, replaceSessionEntry } from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import * as transcript from "./transcript.js";

describe("retained-result transcript fallback", () => {
  const fixture = useTempSessionsFixture("transcript-stall-fallback-");
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(() => {
    vi.restoreAllMocks();
    clearRuntimeConfigSnapshot();
  });

  it("persists one visible result after a transient append and idempotent retry", async () => {
    const sessionKey = "agent:main:stall-fallback";
    const sessionId = "stall-fallback-session";
    const scope = { agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() };
    await replaceSessionEntry(scope, { sessionId, chatType: "direct", updatedAt: 1 });
    const append = vi
      .spyOn(transcript, "appendAssistantMessageToSessionTranscript")
      .mockRejectedValueOnce(new Error("transient append"));
    const params = {
      requesterSessionKey: sessionKey,
      requesterSessionId: sessionId,
      requesterAgentId: "main",
      requesterStorePath: fixture.storePath(),
      idempotencyKey: "stall-fallback:retained-result",
      findings: "retained child result",
      assertCurrent: () => {},
    };
    await expect(deliverRequesterStallFallback(params)).resolves.toMatchObject({
      delivered: false,
      disposition: "retryable",
      reason: "visible_reply_missing",
    });
    await expect(deliverRequesterStallFallback(params)).resolves.toMatchObject({ delivered: true });
    await expect(deliverRequesterStallFallback(params)).resolves.toMatchObject({ delivered: true });
    expect(append.mock.calls.map(([call]) => call.idempotencyKey)).toEqual([
      params.idempotencyKey,
      params.idempotencyKey,
      params.idempotencyKey,
    ]);
    const messages = (await loadTranscriptEvents(scope)).flatMap((event) => {
      const message = asOptionalRecord(event)?.message;
      return message ? [message] : [];
    });
    expect(messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        display: true,
        idempotencyKey: params.idempotencyKey,
        content: [{ type: "text", text: expect.stringContaining(params.findings) }],
      }),
    ]);
    expect(messages[0]).not.toHaveProperty("__openclaw.runId");
  });
});
