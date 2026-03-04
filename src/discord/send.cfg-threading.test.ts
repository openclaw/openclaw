import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessageDiscord } from "./send.js";
import { makeDiscordRest } from "./send.test-harness.js";

vi.mock("../web/media.js", async () => {
  const { discordWebMediaMockFactory } = await import("./send.test-harness.js");
  return discordWebMediaMockFactory();
});

const loadConfigMock = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    loadConfig: (...args: unknown[]) => loadConfigMock(...args),
  };
});

describe("sendMessageDiscord cfg threading", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue({
      channels: { discord: { token: "from-loadConfig", enabled: true } },
    });
  });

  it("uses provided cfg instead of calling loadConfig", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });

    const resolvedCfg = {
      channels: { discord: { token: "resolved-secret", enabled: true } },
    };

    await sendMessageDiscord("channel:789", "hello", {
      cfg: resolvedCfg as never,
      rest,
      token: "t",
    });

    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("falls back to loadConfig when cfg is not provided", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });

    await sendMessageDiscord("channel:789", "hello", {
      rest,
      token: "t",
    });

    expect(loadConfigMock).toHaveBeenCalled();
  });
});
