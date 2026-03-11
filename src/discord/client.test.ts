import type { RequestClient } from "@buape/carbon";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createDiscordRestClient } from "./client.js";

const { undiciFetchMock, proxyAgentSpy } = vi.hoisted(() => ({
  undiciFetchMock: vi.fn(),
  proxyAgentSpy: vi.fn(),
}));

vi.mock("undici", () => {
  class ProxyAgent {
    proxyUrl: string;
    constructor(proxyUrl: string) {
      this.proxyUrl = proxyUrl;
      proxyAgentSpy(proxyUrl);
    }
  }
  return {
    ProxyAgent,
    EnvHttpProxyAgent: class {},
    fetch: undiciFetchMock,
  };
});

describe("createDiscordRestClient", () => {
  const fakeRest = {} as RequestClient;

  it("uses explicit token without resolving config token SecretRefs", () => {
    const cfg = {
      channels: {
        discord: {
          token: {
            source: "exec",
            provider: "vault",
            id: "discord/bot-token",
          },
        },
      },
    } as OpenClawConfig;

    const result = createDiscordRestClient(
      {
        token: "Bot explicit-token",
        rest: fakeRest,
      },
      cfg,
    );

    expect(result.token).toBe("explicit-token");
    expect(result.rest).toBe(fakeRest);
    expect(result.account.accountId).toBe("default");
  });

  it("keeps account retry config when explicit token is provided", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            ops: {
              token: {
                source: "exec",
                provider: "vault",
                id: "discord/ops-token",
              },
              retry: {
                attempts: 7,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = createDiscordRestClient(
      {
        accountId: "ops",
        token: "Bot explicit-account-token",
        rest: fakeRest,
      },
      cfg,
    );

    expect(result.token).toBe("explicit-account-token");
    expect(result.account.accountId).toBe("ops");
    expect(result.account.config.retry).toMatchObject({ attempts: 7 });
  });

  it("still throws when no explicit token is provided and config token is unresolved", () => {
    const cfg = {
      channels: {
        discord: {
          token: {
            source: "file",
            provider: "default",
            id: "/discord/token",
          },
        },
      },
    } as OpenClawConfig;

    expect(() =>
      createDiscordRestClient(
        {
          rest: fakeRest,
        },
        cfg,
      ),
    ).toThrow(/unresolved SecretRef/i);
  });

  it("routes Discord REST requests through configured proxy", async () => {
    undiciFetchMock.mockClear().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    proxyAgentSpy.mockClear();

    const cfg = {
      channels: {
        discord: {
          proxy: "http://proxy.test:8080",
        },
      },
    } as OpenClawConfig;

    const result = createDiscordRestClient(
      {
        token: "Bot explicit-token",
      },
      cfg,
    );

    await result.rest.get("/oauth2/applications/@me");

    expect(proxyAgentSpy).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/oauth2/applications/@me",
      expect.objectContaining({
        method: "GET",
        dispatcher: expect.objectContaining({ proxyUrl: "http://proxy.test:8080" }),
      }),
    );
    const requestInit = undiciFetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((requestInit?.headers as Headers).get("Authorization")).toBe("Bot explicit-token");
  });
});
