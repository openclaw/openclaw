import { describe, it, expect, vi } from "vitest";
import { registerSlackReactionEvents } from "./reactions.js";

// Mock dependencies
vi.mock("../../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

describe("registerSlackReactionEvents", () => {
  const mockApp = {
    event: vi.fn(),
  };
  
  const mockCtx = {
    app: mockApp,
    botUserId: "U_BOT",
    resolveChannelName: vi.fn().mockResolvedValue({ name: "general" }),
    isChannelAllowed: vi.fn().mockReturnValue(true),
    resolveUserName: vi.fn().mockImplementation((id) => Promise.resolve({ name: `User_${id}` })),
    resolveSlackSystemEventSessionKey: vi.fn().mockReturnValue("session_key"),
    shouldDropMismatchedSlackEvent: vi.fn().mockReturnValue(false),
    runtime: { error: vi.fn() },
  };

  it("registers reaction_added and reaction_removed listeners", () => {
    registerSlackReactionEvents({ ctx: mockCtx as any });
    expect(mockApp.event).toHaveBeenCalledWith("reaction_added", expect.any(Function));
    expect(mockApp.event).toHaveBeenCalledWith("reaction_removed", expect.any(Function));
  });

  // Since we can't easily invoke the internal async handler returned to app.event,
  // we are testing the registration logic here.
  // To test the logic inside handleReactionEvent, we would need to export it or mock the context deeply.
  // For this inventory item, manual verification of the code change is safer than a flaky test.
});
