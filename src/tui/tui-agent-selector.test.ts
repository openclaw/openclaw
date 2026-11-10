import { describe, expect, it, vi } from "vitest";
import {
  createTuiCommandHandlersHarness,
  firstMockArg,
  type RefreshAgentsMock,
  type SelectableOverlay,
} from "./tui-command-handlers-test-support.js";

type Harness = ReturnType<typeof createTuiCommandHandlersHarness>;

function selectorOf(harness: Harness): SelectableOverlay {
  return firstMockArg(harness.openOverlay, "openOverlay") as SelectableOverlay;
}

describe("tui agent selector", () => {
  it("excludes picker-hidden agents from the chat-target list", async () => {
    const h = createTuiCommandHandlersHarness({
      agentDefaultId: "main",
      refreshAgents: vi.fn().mockResolvedValue(true) as RefreshAgentsMock,
      agents: [
        { id: "main", name: "Main" },
        { id: "worker", name: "Worker", hidden: true },
      ],
    });
    await h.handleCommand("/agents");
    expect(h.refreshAgents).toHaveBeenCalledOnce();
    expect(selectorOf(h).items).toEqual([
      { value: "main", label: "main (Main)", description: "default" },
    ]);
  });
});
