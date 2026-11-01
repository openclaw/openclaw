import { beforeEach, expect, it, vi } from "vitest";

const diagnosticMocks = vi.hoisted(() => ({
  logMessageProcessed: vi.fn(),
  logMessageQueued: vi.fn(),
  logSessionStateChange: vi.fn(),
}));

// mock-isolation: Capture lifecycle diagnostics without mutating process-wide diagnostic state.
vi.mock("./diagnostic.js", () => diagnosticMocks);

import { createDiagnosticMessageLifecycle } from "./message-lifecycle.js";

beforeEach(() => Object.values(diagnosticMocks).forEach((mock) => mock.mockReset()));

it.each([
  [true, true],
  [true, false],
  [false, true],
])("emits lifecycle events with enabled=%s, tracking=%s", (enabled, trackSessionState) => {
  const ref = trackSessionState
    ? { sessionId: "initial-session", sessionKey: "cron:job" }
    : { sessionId: undefined, sessionKey: undefined };
  const message = { channel: "cron", chatId: "chat-1", messageId: "msg-1" };
  const finalRef = { ...ref, sessionId: trackSessionState ? "final-session" : undefined };
  const outcome = trackSessionState ? "completed" : "skipped";
  const subject = createDiagnosticMessageLifecycle({
    ...ref,
    ...message,
    enabled,
    trackSessionState,
    source: "dispatch",
  });
  subject.markProcessing();
  subject.markIdle("finished", finalRef);
  subject.markProcessed(outcome, { ...finalRef, durationMs: 42, reason: "finished" });

  const {
    logMessageQueued: queued,
    logSessionStateChange: state,
    logMessageProcessed: processed,
  } = diagnosticMocks;
  if (enabled && trackSessionState) {
    expect(queued).toHaveBeenCalledWith({ ...ref, channel: "cron", source: "dispatch" });
    expect(state.mock.calls).toEqual([
      [{ ...ref, state: "waiting", reason: undefined }],
      [{ ...finalRef, state: "idle", reason: "finished" }],
    ]);
  } else {
    expect(queued).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
  }
  if (enabled) {
    expect(processed.mock.calls[0]?.[0]).toMatchObject({
      ...message,
      ...finalRef,
      durationMs: 42,
      outcome,
      reason: "finished",
    });
  } else {
    expect(processed).not.toHaveBeenCalled();
  }
});
