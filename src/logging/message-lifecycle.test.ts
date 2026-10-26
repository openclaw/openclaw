import { beforeEach, expect, it, vi } from "vitest";

const diagnosticMocks = vi.hoisted(() => ({
  logMessageProcessed: vi.fn(),
  logMessageQueued: vi.fn(),
  logSessionStateChange: vi.fn(),
}));

vi.mock("./diagnostic.js", () => diagnosticMocks);

import { createDiagnosticMessageLifecycle } from "./message-lifecycle.js";

beforeEach(() => Object.values(diagnosticMocks).forEach((mock) => mock.mockReset()));

function lifecycle(overrides: Partial<Parameters<typeof createDiagnosticMessageLifecycle>[0]>) {
  return createDiagnosticMessageLifecycle({
    enabled: true,
    channel: "cron",
    source: "dispatch",
    trackSessionState: true,
    ...overrides,
  });
}

it("emits queued, state, and processed events through one lifecycle", () => {
  const ref = { sessionId: "initial-session", sessionKey: "cron:job" };
  const origin = { channel: "cron", source: "cron-isolated" };
  const subject = lifecycle({ ...ref, ...origin });
  const completed = { sessionId: "final-session", durationMs: 42 };
  subject.markProcessing();
  subject.markIdle(undefined, completed);
  subject.markProcessed("completed", completed);

  expect(diagnosticMocks.logMessageQueued).toHaveBeenCalledWith({ ...ref, ...origin });
  expect(diagnosticMocks.logSessionStateChange.mock.calls).toEqual([
    [{ ...ref, state: "waiting", reason: undefined }],
    [{ ...ref, sessionId: "final-session", state: "idle", reason: undefined }],
  ]);
  expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith({
    ...ref,
    ...completed,
    channel: "cron",
    chatId: undefined,
    messageId: undefined,
    outcome: "completed",
    reason: undefined,
    error: undefined,
  });
});

it("keeps processed events independent of session-state tracking", () => {
  const message = { channel: "whatsapp", chatId: "chat-1", messageId: "msg-1" };
  const skipped = { durationMs: 7, reason: "duplicate" };
  const subject = lifecycle({ ...message, trackSessionState: false });

  subject.markProcessing();
  subject.markIdle("message_completed");
  subject.markProcessed("skipped", skipped);

  expect(diagnosticMocks.logMessageQueued).not.toHaveBeenCalled();
  expect(diagnosticMocks.logSessionStateChange).not.toHaveBeenCalled();
  expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith({
    ...message,
    ...skipped,
    sessionId: undefined,
    sessionKey: undefined,
    outcome: "skipped",
    error: undefined,
  });
});

it("emits nothing when disabled", () => {
  const subject = lifecycle({ enabled: false, channel: "slack", sessionKey: "agent:main" });

  subject.markProcessing();
  subject.markIdle("message_completed");
  subject.markProcessed("completed", { durationMs: 1 });

  for (const mock of Object.values(diagnosticMocks)) {
    expect(mock).not.toHaveBeenCalled();
  }
});
