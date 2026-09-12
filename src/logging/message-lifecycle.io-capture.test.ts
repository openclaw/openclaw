// Tests that message lifecycle I/O (userPrompt/finalResponse) flows through
// to logMessageProcessed for OTEL message.processed span capture.
// These tests exist because the otel-improvements patch's recorder reads
// privateData.messageContent for span attributes, but the data was silently
// absent when the dispatch flow didn't wire it — a gap the recorder-only
// tests could not catch.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock diagnostic.js to capture logMessageProcessed calls without
// actually emitting diagnostic events.
vi.mock("./diagnostic.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./diagnostic.js")>();
  return {
    ...actual,
    logMessageProcessed: vi.fn(),
    logMessageQueued: vi.fn(),
    logSessionStateChange: vi.fn(),
  };
});

import { logMessageProcessed } from "./diagnostic.js";
import { createDiagnosticMessageLifecycle } from "./message-lifecycle.js";

describe("message lifecycle I/O capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes userPrompt from lifecycle creation through to markProcessed", () => {
    const lifecycle = createDiagnosticMessageLifecycle({
      enabled: true,
      channel: "slack",
      source: "test",
      chatId: "123",
      messageId: "456",
      sessionKey: "test-session",
      trackSessionState: false,
      userPrompt: "What is the weather?",
    });

    lifecycle.markProcessed("completed", { finalResponse: "It's sunny." });

    expect(logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: "What is the weather?",
        finalResponse: "It's sunny.",
      }),
    );
  });

  it("passes finalResponse from markProcessed options even without lifecycle userPrompt", () => {
    const lifecycle = createDiagnosticMessageLifecycle({
      enabled: true,
      channel: "slack",
      source: "test",
      trackSessionState: false,
    });

    lifecycle.markProcessed("completed", { finalResponse: "Reply text." });

    expect(logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        finalResponse: "Reply text.",
        userPrompt: undefined,
      }),
    );
  });

  it("markProcessed options userPrompt overrides lifecycle-level userPrompt", () => {
    const lifecycle = createDiagnosticMessageLifecycle({
      enabled: true,
      channel: "slack",
      source: "test",
      trackSessionState: false,
      userPrompt: "lifecycle-level prompt",
    });

    lifecycle.markProcessed("completed", {
      userPrompt: "per-call override",
      finalResponse: "response",
    });

    expect(logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: "per-call override",
      }),
    );
  });

  it("does not pass userPrompt or finalResponse when neither is provided", () => {
    const lifecycle = createDiagnosticMessageLifecycle({
      enabled: true,
      channel: "slack",
      source: "test",
      trackSessionState: false,
    });

    lifecycle.markProcessed("completed");

    expect(logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: undefined,
        finalResponse: undefined,
      }),
    );
  });

  it("does not emit when lifecycle is disabled", () => {
    const lifecycle = createDiagnosticMessageLifecycle({
      enabled: false,
      channel: "slack",
      source: "test",
      trackSessionState: false,
      userPrompt: "should not appear",
    });

    lifecycle.markProcessed("completed", { finalResponse: "neither should this" });

    expect(logMessageProcessed).not.toHaveBeenCalled();
  });
});
