import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state.ts";
import { promptAndRenameChatSession } from "./session-rename.ts";

vi.mock("../controllers/sessions.ts", () => ({
  patchSession: vi.fn(async () => undefined),
}));

import { patchSession } from "../controllers/sessions.ts";

const patchSessionMock = vi.mocked(patchSession);

function createState(): AppViewState {
  return {
    client: { request: vi.fn() },
    connected: true,
    sessionsShowArchived: false,
    assistantAgentId: "main",
    agentsList: [],
    hello: null,
  } as unknown as AppViewState;
}

describe("promptAndRenameChatSession", () => {
  beforeEach(() => {
    patchSessionMock.mockClear();
    vi.restoreAllMocks();
  });

  it("renames a session through the shared chat-scoped patch path", async () => {
    const state = createState();
    const prompt = vi.spyOn(globalThis, "prompt").mockReturnValue("Renamed session");

    await expect(
      promptAndRenameChatSession(
        state,
        { key: "agent:main:history", label: "History" },
        "History fallback",
      ),
    ).resolves.toBe(true);

    expect(prompt).toHaveBeenCalledWith("Rename session", "History");
    expect(patchSessionMock).toHaveBeenCalledWith(
      state,
      "agent:main:history",
      { label: "Renamed session" },
      {
        activeMinutes: 0,
        agentId: "main",
        configuredAgentsOnly: true,
        includeDerivedTitles: true,
        includeGlobal: true,
        includeUnknown: true,
        limit: 50,
        showArchived: false,
      },
    );
  });

  it("clears an existing label when the prompt is blank", async () => {
    const state = createState();
    vi.spyOn(globalThis, "prompt").mockReturnValue("   ");

    await expect(
      promptAndRenameChatSession(state, { key: "agent:main:history", label: "History" }, "History"),
    ).resolves.toBe(true);

    expect(patchSessionMock).toHaveBeenCalledWith(
      state,
      "agent:main:history",
      { label: null },
      expect.objectContaining({ includeDerivedTitles: true }),
    );
  });

  it("does not patch when the prompt is cancelled", async () => {
    const state = createState();
    vi.spyOn(globalThis, "prompt").mockReturnValue(null);

    await expect(
      promptAndRenameChatSession(state, { key: "agent:main:history", label: "History" }, "History"),
    ).resolves.toBe(false);

    expect(patchSessionMock).not.toHaveBeenCalled();
  });
});
