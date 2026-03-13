import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTelegramFetch } from "../telegram/fetch.js";
import { fetchRemoteMedia } from "./fetch.js";

const undiciFetch = vi.hoisted(() => vi.fn());
const AgentCtor = vi.hoisted(() =>
  vi.fn(function MockAgent(
    this: { options?: Record<string, unknown> },
    options?: Record<string, unknown>,
  ) {
    this.options = options;
  }),
);
const EnvHttpProxyAgentCtor = vi.hoisted(() =>
  vi.fn(function MockEnvHttpProxyAgent(
    this: { options?: Record<string, unknown> },
    options?: Record<string, unknown>,
  ) {
    this.options = options;
  }),
);
const ProxyAgentCtor = vi.hoisted(() =>
  vi.fn(function MockProxyAgent(
    this: { options?: Record<string, unknown> | string },
    options?: Record<string, unknown> | string,
  ) {
    this.options = options;
  }),
);

vi.mock("undici", () => ({
  Agent: AgentCtor,
  EnvHttpProxyAgent: EnvHttpProxyAgentCtor,
  ProxyAgent: ProxyAgentCtor,
  fetch: undiciFetch,
}));

describe("fetchRemoteMedia telegram network policy", () => {
  type LookupFn = NonNullable<Parameters<typeof fetchRemoteMedia>[0]["lookupFn"]>;

  afterEach(() => {
    undiciFetch.mockReset();
    AgentCtor.mockClear();
    EnvHttpProxyAgentCtor.mockClear();
    ProxyAgentCtor.mockClear();
    vi.unstubAllEnvs();
  });

  it("preserves Telegram resolver transport policy for file downloads", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "149.154.167.220", family: 4 },
    ]) as unknown as LookupFn;
    undiciFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );

    const telegramFetch = resolveTelegramFetch(undefined, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "verbatim",
      },
    });

    await fetchRemoteMedia({
      url: "https://api.telegram.org/file/bottok/photos/1.jpg",
      fetchImpl: telegramFetch,
      lookupFn,
      maxBytes: 1024,
      ssrfPolicy: {
        allowedHostnames: ["api.telegram.org"],
        allowRfc2544BenchmarkRange: true,
      },
    });

    const init = undiciFetch.mock.calls[0]?.[1] as
      | (RequestInit & {
          dispatcher?: {
            options?: {
              connect?: Record<string, unknown>;
            };
          };
        })
      | undefined;

    expect(init?.dispatcher?.options?.connect).toEqual(
      expect.objectContaining({
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
        lookup: expect.any(Function),
      }),
    );
  });
});
