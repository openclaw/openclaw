// Verifies session descriptions stay with the selected TUI conversation.
import { describe, expect, it, vi } from "vitest";
import {
  createBaseState,
  createTestSessionActions,
  makeTuiBackend,
} from "./tui-session-actions-test-support.js";

describe("TUI session description ownership", () => {
  it("includes the global row when refreshing a global session", async () => {
    const describeSession = vi.fn().mockResolvedValue({
      defaults: {},
      session: { key: "global", updatedAt: 1 },
    });
    const state = createBaseState({
      currentSessionKey: "global",
      sessionScope: "global",
    });

    const { refreshSessionInfo } = createTestSessionActions({
      client: makeTuiBackend({ describeSession }),
      state,
    });

    await refreshSessionInfo();

    expect(describeSession).toHaveBeenCalledWith({
      sessionKey: "global",
      agentId: "main",
    });
  });

  it.each([
    { selectedKey: "global", returnedKey: "global", accepted: true },
    { selectedKey: "global", returnedKey: "agent:work:global", accepted: true },
    { selectedKey: "agent:work:global", returnedKey: "agent:work:global", accepted: true },
    { selectedKey: "global", returnedKey: "agent:main:global", accepted: false },
    { selectedKey: "agent:work:global", returnedKey: "agent:main:global", accepted: false },
  ])(
    "keeps the selected owner when describing $selectedKey as $returnedKey",
    async ({ selectedKey, returnedKey, accepted }) => {
      const describeSession = vi.fn().mockResolvedValue({
        defaults: {},
        session: {
          key: returnedKey,
          sessionId: "described-session",
          displayName: "Updated conversation",
          updatedAt: 1,
        },
      });
      const state = createBaseState({
        currentAgentId: "work",
        currentSessionKey: selectedKey,
        currentSessionId: "selected-session",
        sessionScope: "global",
        sessionInfo: { displayName: "Selected conversation" },
      });
      const { refreshSessionInfo } = createTestSessionActions({
        client: makeTuiBackend({ describeSession }),
        state,
      });

      await refreshSessionInfo();

      expect(describeSession).toHaveBeenCalledWith({
        sessionKey: selectedKey,
        ...(selectedKey === "global" ? { agentId: "work" } : {}),
      });
      expect(state).toMatchObject({
        currentAgentId: "work",
        currentSessionKey: accepted ? returnedKey : selectedKey,
        currentSessionId: accepted ? "described-session" : "selected-session",
        sessionInfo: {
          displayName: accepted ? "Updated conversation" : "Selected conversation",
        },
      });
    },
  );
});
