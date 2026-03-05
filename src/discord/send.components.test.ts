import { ChannelType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions.js";
import { registerDiscordComponentEntries } from "./components-registry.js";
import { sendDiscordComponentMessage } from "./send.components.js";
import { makeDiscordRest } from "./send.test-harness.js";

const loadConfigMock = vi.hoisted(() => vi.fn(() => ({ session: { dmScope: "main" } })));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: (..._args: unknown[]) => loadConfigMock(),
  };
});

vi.mock("./components-registry.js", () => ({
  registerDiscordComponentEntries: vi.fn(),
}));

vi.mock("../config/sessions.js", () => ({
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({
    ok: true as const,
    sessionFile: "session.jsonl",
  })),
}));

describe("sendDiscordComponentMessage", () => {
  const registerMock = vi.mocked(registerDiscordComponentEntries);
  const appendTranscriptMock = vi.mocked(appendAssistantMessageToSessionTranscript);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps direct-channel DM session keys on component entries", async () => {
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValueOnce({
      type: ChannelType.DM,
      recipients: [{ id: "user-1" }],
    });
    postMock.mockResolvedValueOnce({ id: "msg1", channel_id: "dm-1" });

    await sendDiscordComponentMessage(
      "channel:dm-1",
      {
        blocks: [{ type: "actions", buttons: [{ label: "Tap" }] }],
      },
      {
        rest,
        token: "t",
        sessionKey: "agent:main:discord:channel:dm-1",
        agentId: "main",
      },
    );

    expect(registerMock).toHaveBeenCalledTimes(1);
    const args = registerMock.mock.calls[0]?.[0];
    expect(args?.entries[0]?.sessionKey).toBe("agent:main:discord:channel:dm-1");
    expect(appendTranscriptMock).toHaveBeenCalledTimes(1);
    expect(appendTranscriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:discord:channel:dm-1",
        agentId: "main",
        text: expect.stringContaining("Tap"),
      }),
    );
  });
});
