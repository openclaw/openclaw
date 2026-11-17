// Pinned trusted-host endpoint tests run the real SSRF guard: trusted mode keeps
// refusing private hosts; exact-host trust honors the configured host as typed,
// including loopback, refuses cloud-metadata destinations in direct and env-proxy
// mode, and still rejects loopback, unspecified, link-local and metadata DNS
// answers for a configured name.
import { isIP } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROXY_ENV_KEYS } from "../../infra/net/proxy-env.js";
import { SsrFBlockedError } from "../../infra/net/ssrf.js";
import {
  withPinnedTrustedHostWebToolsEndpoint,
  withTrustedWebToolsEndpoint,
} from "./web-guarded-fetch.js";

type LookupFn = NonNullable<Parameters<typeof withTrustedWebToolsEndpoint>[0]["lookupFn"]>;

const CONFIGURED_HOST = "tavily.gateway.internal";
const CONFIGURED_URL = `https://${CONFIGURED_HOST}/search`;
const PRIVATE_NAMES = [
  "proxy.example.internal",
  "tavily.corp.local",
  "tavily.localhost",
  "10.0.0.5",
];
const PRIVATE_HOSTS = [...PRIVATE_NAMES, "[fd00::1]"] as const;
// The trusted fake-IP policy exempts fd00::/7 on purpose (see
// `allowIpv6UniqueLocalRange`), so loopback stands in for the IPv6 literal here.
const TRUSTED_BLOCKED_HOSTS = [...PRIVATE_NAMES, "[::1]"] as const;
const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]", "localhost", "tavily.localhost"] as const;
// Metadata destinations in every encoding the guard classifies, plus the
// hostname the guard already blocks; none may gain exact-host trust.
const METADATA_HOSTS = [
  "169.254.169.254",
  "[::ffff:169.254.169.254]",
  "[fd00:ec2::254]",
  "100.100.100.200",
  "metadata.google.internal",
] as const;
const METADATA_ADDRESSES = ["169.254.169.254", "fd00:ec2::254", "100.100.100.200"] as const;

/** Resolves names to `nameAddress` and passes IP literals through, like a private zone or hosts file. */
function createPassthroughLookup(nameAddress = "10.0.0.5"): LookupFn {
  return vi.fn(async (hostname: string) => {
    const family = isIP(hostname);
    return [family ? { address: hostname, family } : { address: nameAddress, family: 4 }];
  }) as unknown as LookupFn;
}

function createFixedLookup(address: string): LookupFn {
  return vi.fn(async () => [{ address, family: isIP(address) }]) as unknown as LookupFn;
}

function okResponse(): Response {
  return new Response("ok", { status: 200 });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function stubEnvProxy() {
  for (const key of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"]) {
    vi.stubEnv(key, "http://127.0.0.1:7890");
  }
}

describe("pinned trusted-host web tools endpoint", () => {
  beforeEach(() => {
    // Env proxy routing would skip local DNS pinning; keep both modes on the pinned path.
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ["93.184.216.34", true],
    ["127.0.0.1", false],
  ] as const)(
    "trusted mode checks the hosted API host's DNS answer %s (reached: %s)",
    async (address, reached) => {
      const fetchImpl = vi.fn(async () => okResponse());
      const request = withTrustedWebToolsEndpoint(
        { url: "https://api.tavily.com/search", fetchImpl, lookupFn: createFixedLookup(address) },
        async (result) => result.finalUrl,
      );

      if (reached) {
        await expect(request).resolves.toBe("https://api.tavily.com/search");
      } else {
        await expect(request).rejects.toBeInstanceOf(SsrFBlockedError);
      }
      expect(fetchImpl).toHaveBeenCalledTimes(reached ? 1 : 0);
    },
  );

  it.each(TRUSTED_BLOCKED_HOSTS)("trusted mode refuses %s before any request", async (host) => {
    const fetchImpl = vi.fn(async () => okResponse());

    await expect(
      withTrustedWebToolsEndpoint(
        { url: `https://${host}/search`, fetchImpl, lookupFn: createPassthroughLookup() },
        async () => "reached",
      ),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ...[...PRIVATE_HOSTS, CONFIGURED_HOST].map((host) => [`https://${host}/search`, "10.0.0.5"]),
    // Operator-configured loopback endpoints, with names resolving like a hosts-file entry.
    ...LOOPBACK_HOSTS.map((host) => [`http://${host}:8080/search`, "127.0.0.1"]),
  ])("pinned trusted-host mode reaches the configured endpoint %s", async (url, nameAddress) => {
    const fetchImpl = vi.fn(async () => okResponse());

    const finalUrl = await withPinnedTrustedHostWebToolsEndpoint(
      { url, fetchImpl, lookupFn: createPassthroughLookup(nameAddress) },
      async (result) => result.finalUrl,
    );

    expect(finalUrl).toBe(url);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(METADATA_HOSTS.flatMap((host) => [[host, false] as const, [host, true] as const]))(
    "pinned trusted-host mode refuses the metadata destination %s (env proxy: %s) before any lookup or request",
    async (host, proxied) => {
      // An env proxy would resolve the name and perform no address check, so the
      // refusal has to happen before any dispatch.
      if (proxied) {
        stubEnvProxy();
      }
      const fetchImpl = vi.fn(async () => okResponse());
      const lookupFn = createPassthroughLookup();

      await expect(
        withPinnedTrustedHostWebToolsEndpoint(
          { url: `http://${host}/search`, fetchImpl, lookupFn },
          async () => "reached",
        ),
      ).rejects.toBeInstanceOf(SsrFBlockedError);
      expect(lookupFn).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("pinned trusted-host mode refuses an endpoint that is not an http(s) URL", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const lookupFn = createPassthroughLookup();

    await expect(
      withPinnedTrustedHostWebToolsEndpoint(
        { url: `ftp://${CONFIGURED_HOST}/search`, fetchImpl, lookupFn },
        async () => "reached",
      ),
    ).rejects.toThrow("Invalid URL: must be http or https");
    expect(lookupFn).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([...PRIVATE_HOSTS, "api.tavily.com"])(
    "pinned trusted-host mode refuses a redirect from the configured host to %s",
    async (host) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(redirectResponse(`https://${host}/search`))
        .mockResolvedValue(okResponse());

      await expect(
        withPinnedTrustedHostWebToolsEndpoint(
          { url: CONFIGURED_URL, fetchImpl, lookupFn: createPassthroughLookup() },
          async () => "reached",
        ),
      ).rejects.toBeInstanceOf(SsrFBlockedError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("pinned trusted-host mode follows a redirect that stays on the configured host", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(`https://${CONFIGURED_HOST}/v1/search`))
      .mockResolvedValue(okResponse());

    const finalUrl = await withPinnedTrustedHostWebToolsEndpoint(
      { url: CONFIGURED_URL, fetchImpl, lookupFn: createPassthroughLookup() },
      async (result) => result.finalUrl,
    );

    expect(finalUrl).toBe(`https://${CONFIGURED_HOST}/v1/search`);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ...["127.0.0.1", "::1", "0.0.0.0", ...METADATA_ADDRESSES].map((ip) => [ip, false] as const),
    ...["10.0.0.5", "192.168.1.20", "fd00::1"].map((ip) => [ip, true] as const),
  ])(
    "pinned trusted-host mode checks the configured name's DNS answer %s (reached: %s)",
    async (address, reached) => {
      const fetchImpl = vi.fn(async () => okResponse());
      const lookupFn = createFixedLookup(address);
      const request = withPinnedTrustedHostWebToolsEndpoint(
        { url: CONFIGURED_URL, fetchImpl, lookupFn },
        async (result) => result.finalUrl,
      );

      if (reached) {
        await expect(request).resolves.toBe(CONFIGURED_URL);
      } else {
        await expect(request).rejects.toBeInstanceOf(SsrFBlockedError);
      }
      expect(lookupFn).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(reached ? 1 : 0);
    },
  );

  it.each([false, true])(
    "pinned trusted-host mode under an env proxy skips local DNS and keeps the hostname rule (off-host redirect: %s)",
    async (redirected) => {
      // With an env proxy the proxy resolves the name, as for every trusted call,
      // so the hostname allowlist is the check that still applies to every hop.
      stubEnvProxy();
      const lookupFn = createFixedLookup("10.0.0.5");
      const fetchImpl = vi.fn(async () =>
        redirected ? redirectResponse("https://proxy.example.internal/search") : okResponse(),
      );
      const request = withPinnedTrustedHostWebToolsEndpoint(
        { url: CONFIGURED_URL, fetchImpl, lookupFn },
        async (result) => result.finalUrl,
      );

      if (redirected) {
        await expect(request).rejects.toBeInstanceOf(SsrFBlockedError);
      } else {
        await expect(request).resolves.toBe(CONFIGURED_URL);
      }
      expect(lookupFn).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("pinned trusted-host mode still enforces the request timeout", async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              const reason: unknown = init.signal?.reason;
              reject(reason instanceof Error ? reason : new Error("aborted"));
            },
            { once: true },
          );
        }),
    );

    await expect(
      withPinnedTrustedHostWebToolsEndpoint(
        { url: CONFIGURED_URL, timeoutMs: 20, fetchImpl, lookupFn: createPassthroughLookup() },
        async () => "reached",
      ),
    ).rejects.toThrow("request timed out");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
