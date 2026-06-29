import { describe, expect, it, vi } from "vitest";

// Capture the subsystem logger's error spy so the test can assert that a
// rejected terminal persistence is logged instead of silently swallowed.
const loggerMocks = vi.hoisted(() => {
  const error = vi.fn();
  const noop = vi.fn();
  const make = (): Record<string, unknown> => ({
    subsystem: "gateway/chat-abort",
    isEnabled: () => true,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error,
    fatal: noop,
    raw: noop,
    child: () => make(),
  });
  return { error, make };
});

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => loggerMocks.make(),
}));

import { type ChatAbortControllerEntry, registerChatAbortController } from "./chat-abort.js";

describe("chat abort terminal persistence logging", () => {
  it("logs and still releases the controller when terminal persistence rejects", async () => {
    loggerMocks.error.mockClear();
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId: "run-rejecting",
      sessionId: "sess-1",
      sessionKey: "main",
      timeoutMs: 60_000,
    });
    if (!registration.entry) {
      throw new Error("expected registered entry");
    }
    const persistence = Promise.reject(new Error("disk full"));
    registration.entry.projectSessionActive = false;
    registration.entry.projectSessionTerminalPersistence = persistence;

    registration.cleanup();

    // Settle the rejected persistence and the trailing cleanup microtask.
    await persistence.catch(() => undefined);
    await Promise.resolve();

    expect(chatAbortControllers.has("run-rejecting")).toBe(false);
    expect(loggerMocks.error).toHaveBeenCalledTimes(1);
    expect(loggerMocks.error.mock.calls[0]?.[0]).toContain("run-rejecting");
    expect(loggerMocks.error.mock.calls[0]?.[0]).toContain("disk full");
  });
});
