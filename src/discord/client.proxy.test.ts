import { describe, expect, it, vi } from "vitest";

const requestClientCtorMock = vi.fn();
const proxyAgentCtorMock = vi.fn();

vi.mock("undici", () => ({
  ProxyAgent: class ProxyAgent {
    constructor(url: string) {
      proxyAgentCtorMock(url);
    }
  },
}));

vi.mock("@buape/carbon", () => ({
  RequestClient: class RequestClient {
    constructor(token: string, options?: unknown) {
      requestClientCtorMock(token, options);
    }
  },
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    channels: {
      discord: {
        enabled: true,
        token: "cfg-token",
        proxy: "http://127.0.0.1:7890",
        accounts: {
          default: {},
        },
      },
    },
  })),
}));

vi.mock("./accounts.js", () => ({
  resolveDiscordAccount: ({ cfg, accountId }: { cfg: unknown; accountId?: string }) => {
    const base = (
      cfg as {
        channels: {
          discord: {
            token: string;
            accounts: Record<string, unknown>;
          };
        };
      }
    ).channels.discord;
    const account =
      (base.accounts[accountId ?? "default"] as Record<string, unknown> | undefined) ?? {};
    return {
      accountId: accountId ?? "default",
      enabled: true,
      token: base.token,
      tokenSource: "config",
      config: { ...base, ...account },
    };
  },
}));

vi.mock("./token.js", () => ({
  normalizeDiscordToken: (value?: string) => value,
}));

import { createDiscordRestClient } from "./client.js";

describe("discord client proxy wiring", () => {
  it("passes an undici ProxyAgent dispatcher into Carbon RequestClient when proxy is configured", () => {
    requestClientCtorMock.mockClear();
    proxyAgentCtorMock.mockClear();

    createDiscordRestClient({ accountId: "default" });

    expect(proxyAgentCtorMock).toHaveBeenCalledWith("http://127.0.0.1:7890");
    expect(requestClientCtorMock).toHaveBeenCalledTimes(1);

    const [_token, options] = requestClientCtorMock.mock.calls[0];
    expect(options).toBeTruthy();
    expect((options as { dispatcher?: unknown }).dispatcher).toBeTruthy();
  });
});
