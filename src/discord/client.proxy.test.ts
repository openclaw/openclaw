import type { RequestClient } from "@buape/carbon";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const { applyDiscordProxyToRequestClientMock } = vi.hoisted(() => ({
  applyDiscordProxyToRequestClientMock: vi.fn((rest: RequestClient) => rest),
}));

vi.mock("./request-client-proxy.js", () => ({
  applyDiscordProxyToRequestClient: applyDiscordProxyToRequestClientMock,
}));

describe("createDiscordRestClient proxy integration", () => {
  it("applies the account proxy to newly created Discord REST clients", async () => {
    const { createDiscordRestClient } = await import("./client.js");
    const cfg = {
      channels: {
        discord: {
          accounts: {
            main: {
              token: "discord-token",
              proxy: "http://proxy.test:8080",
            },
          },
        },
      },
    } as OpenClawConfig;

    createDiscordRestClient(
      {
        accountId: "main",
      },
      cfg,
    );

    expect(applyDiscordProxyToRequestClientMock).toHaveBeenCalledWith(
      expect.any(Object),
      "http://proxy.test:8080",
    );
  });
});
