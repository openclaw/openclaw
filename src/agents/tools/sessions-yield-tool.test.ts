import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const queueEmbeddedPiMessageMock = vi.fn();
  return { queueEmbeddedPiMessageMock };
});

vi.mock("../pi-embedded.js", () => ({
  queueEmbeddedPiMessage: (...args: unknown[]) => hoisted.queueEmbeddedPiMessageMock(...args),
}));

const { createSessionsYieldTool } = await import("./sessions-yield-tool.js");

describe("sessions_yield tool", () => {
  beforeEach(() => {
    hoisted.queueEmbeddedPiMessageMock.mockReset();
  });

  it("returns error when no sessionId is provided", async () => {
    const tool = createSessionsYieldTool();
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({
      status: "error",
      error: "No session context",
    });
    expect(hoisted.queueEmbeddedPiMessageMock).not.toHaveBeenCalled();
  });

  it("returns error when session is not active", async () => {
    hoisted.queueEmbeddedPiMessageMock.mockReturnValue(false);
    const tool = createSessionsYieldTool({ sessionId: "test-session" });
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({
      status: "error",
      error: "Session not active or not streaming",
    });
  });

  it("yields successfully with default message", async () => {
    hoisted.queueEmbeddedPiMessageMock.mockReturnValue(true);
    const tool = createSessionsYieldTool({ sessionId: "test-session" });
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({ status: "yielded" });
    expect(hoisted.queueEmbeddedPiMessageMock).toHaveBeenCalledWith(
      "test-session",
      expect.stringContaining("Turn yielded."),
    );
  });

  it("yields with custom message", async () => {
    hoisted.queueEmbeddedPiMessageMock.mockReturnValue(true);
    const tool = createSessionsYieldTool({ sessionId: "test-session" });
    const result = await tool.execute("call-1", { message: "Waiting for fact-checker" });
    expect(result.details).toMatchObject({ status: "yielded" });
    expect(hoisted.queueEmbeddedPiMessageMock).toHaveBeenCalledWith(
      "test-session",
      expect.stringContaining("Waiting for fact-checker"),
    );
  });

  it("includes system directive in steer text", async () => {
    hoisted.queueEmbeddedPiMessageMock.mockReturnValue(true);
    const tool = createSessionsYieldTool({ sessionId: "test-session" });
    await tool.execute("call-1", { message: "Waiting" });
    const steerText = hoisted.queueEmbeddedPiMessageMock.mock.calls[0][1];
    expect(steerText).toContain("[SYSTEM]");
    expect(steerText).toContain("Do NOT call any tools");
  });
});
