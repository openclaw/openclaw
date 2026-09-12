import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlacementStartupHarness } from "./session-placement-startup.test-support.ts";
import { createApplicationPlacementStartup } from "./session-placement-startup.ts";

// Serialized contract from v2026.9.3 (1391f7cd2d40), independent of today's writer/key helper.
const storedKey =
  "openclaw.new-session.session-placement-recovery.v1:20:ws://gateway.example:11:principal-a:19:agent:cloud:startup";
const storedSubmission = {
  sessionKey: "agent:cloud:startup",
  messageId: "message-stable",
  message: "fix the cloud task",
  attachments: [{ type: "file", mimeType: "text/plain", fileName: "note.txt", content: "SGk=" }],
  target: { kind: "profile", profileId: "aws" },
  agentId: "cloud",
  gatewayUrl: "ws://gateway.example",
  recoveryScope: "principal-a",
};

describe("application placement recovery format compatibility", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { name: "v1 sending", phase: "sending", sendError: undefined },
    { name: "v1 paused", phase: "paused", sendError: undefined },
    { name: "v1 with additive diagnostic", phase: "paused", sendError: "original socket error" },
  ])("restores $name through checking, rewrite, reload, and receipt retirement", async (record) => {
    let accepted = false;
    let historyError = "restored send history unavailable";
    const request = vi.fn((method: string) => {
      if (method !== "chat.history") {
        throw new Error(`Unexpected ${method} during recovery`);
      }
      return accepted
        ? Promise.resolve({
            messages: [],
            inputReceipts: [{ runId: "message-stable", state: "pending" }],
          })
        : Promise.reject(new Error(historyError));
    });
    const { startup, dependencies } = createPlacementStartupHarness(request);
    startup.dispose();
    sessionStorage.clear();
    const raw = JSON.stringify({
      ...storedSubmission,
      phase: record.phase,
      ...(record.phase === "paused"
        ? { reason: "unconfirmed", error: "previous delivery check failed" }
        : {}),
      sendError: record.sendError,
    });
    sessionStorage.setItem(storedKey, raw);
    let restored = createApplicationPlacementStartup(dependencies);
    try {
      restored.resumeRecovery();
      await vi.waitFor(() =>
        expect(restored.get(storedSubmission.sessionKey)).toMatchObject({
          phase: "failed",
          action: "check-delivery",
          initialTurn: {
            text: storedSubmission.message,
            sendRunId: storedSubmission.messageId,
            sendState: "unconfirmed",
            attachments: [{ dataUrl: "data:text/plain;base64,SGk=" }],
          },
        }),
      );
      const initialChecks = record.phase === "sending" ? 1 : 0;
      expect(request).toHaveBeenCalledTimes(initialChecks);
      if (record.phase === "paused") {
        expect(sessionStorage.getItem(storedKey)).toBe(raw);
      }
      historyError = "history after upgrade unavailable";
      restored.retry(storedSubmission.sessionKey);
      await vi.waitFor(() =>
        expect(restored.get(storedSubmission.sessionKey)?.error).toContain(historyError),
      );
      const rewritten = JSON.parse(sessionStorage.getItem(storedKey) ?? "null");
      expect(rewritten).toEqual({
        ...storedSubmission,
        phase: "paused",
        reason: "unconfirmed",
        error: historyError,
        ...(record.sendError ? { sendError: record.sendError } : {}),
      });
      expect(sessionStorage.length).toBe(1);
      expect(request).toHaveBeenCalledTimes(initialChecks + 1);
      restored.dispose();
      restored = createApplicationPlacementStartup(dependencies);
      restored.resumeRecovery();
      await vi.waitFor(() =>
        expect(restored.get(storedSubmission.sessionKey)?.error).toContain(historyError),
      );
      if (record.sendError) {
        expect(restored.get(storedSubmission.sessionKey)?.error).toContain(record.sendError);
      }
      expect(request).toHaveBeenCalledTimes(initialChecks + 1);
      accepted = true;
      restored.retry(storedSubmission.sessionKey);
      await vi.waitFor(() => expect(restored.get(storedSubmission.sessionKey)).toBeNull());
      expect(restored.hasPendingTurn(storedSubmission.sessionKey)).toBe(false);
      expect(sessionStorage.getItem(storedKey)).toBeNull();
      expect(request.mock.calls.map(([method]) => method)).toEqual(
        Array.from({ length: initialChecks + 2 }, () => "chat.history"),
      );
    } finally {
      restored.dispose();
    }
  });
});
