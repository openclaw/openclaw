import { describe, expect, it, vi } from "vitest";
import { setAssistantAvatarOverride } from "./assistant-identity.ts";

describe("setAssistantAvatarOverride", () => {
  it("writes the assistant avatar override through config.patch", async () => {
    const request = vi.fn().mockResolvedValue({});

    await setAssistantAvatarOverride(
      {
        client: { request } as never,
        connected: true,
        applySessionKey: "agent:main",
        configSnapshot: { hash: "config-hash" },
      },
      "data:image/png;base64,YXZhdGFy",
    );

    expect(request).toHaveBeenCalledWith("config.patch", {
      baseHash: "config-hash",
      raw: JSON.stringify({ ui: { assistant: { avatar: "data:image/png;base64,YXZhdGFy" } } }),
      sessionKey: "agent:main",
      note: "Assistant avatar override updated from Control UI.",
    });
  });

  it("clears the assistant avatar override through config.patch", async () => {
    const request = vi.fn().mockResolvedValue({});

    await setAssistantAvatarOverride(
      {
        client: { request } as never,
        connected: true,
        configSnapshot: { hash: "config-hash" },
      },
      null,
    );

    expect(request).toHaveBeenCalledWith("config.patch", {
      baseHash: "config-hash",
      raw: JSON.stringify({ ui: { assistant: { avatar: null } } }),
      sessionKey: undefined,
      note: "Assistant avatar override cleared from Control UI.",
    });
  });
});
