import { describe, expect, it, vi } from "vitest";

const buildStatusTextMock = vi.hoisted(() => vi.fn(async () => "status"));

vi.mock("../../auto-reply/reply/commands-status.js", () => ({
  buildStatusText: buildStatusTextMock,
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    loadSessionStore: () => ({
      main: {
        sessionId: "s1",
        updatedAt: 10,
      },
    }),
    resolveStorePath: () => "/tmp/main/sessions.json",
    updateSessionStore: vi.fn(async () => undefined),
  };
});

describe("session_status current run model snapshot", () => {
  it("prefers the current requester run model for self status cards when no override is set", async () => {
    const { createSessionStatusTool } = await import("./session-status-tool.js");
    const tool = createSessionStatusTool({
      agentSessionKey: "main",
      currentModelProvider: "openai-crs",
      currentModelId: "gpt-5.4",
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: {
          defaults: {
            model: { primary: "claude-cli/sonnet" },
            models: {},
          },
        },
        tools: {
          agentToAgent: { enabled: false },
        },
      } as never,
    });

    await tool.execute("call-current-live-model", {});

    expect(buildStatusTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-crs",
        model: "gpt-5.4",
        sessionEntry: expect.objectContaining({
          modelProvider: "openai-crs",
          model: "gpt-5.4",
        }),
      }),
    );
  });
});
