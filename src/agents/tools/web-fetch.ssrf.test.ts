import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import { type FetchMock, withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { makeFetchHeaders } from "./web-fetch.test-harness.js";
import "./web-fetch.test-mocks.js";

const lookupMock = vi.fn();
const resolvePinnedHostname = ssrf.resolvePinnedHostname;

function redirectResponse(location: string): Response {
  return {
    ok: false,
    status: 302,
    headers: makeFetchHeaders({ location }),
    body: { cancel: vi.fn() },
  } as unknown as Response;
}

function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: makeFetchHeaders({ "content-type": "text/plain" }),
    text: async () => body,
  } as unknown as Response;
}

function setMockFetch(
  impl: FetchMock = async (_input: RequestInfo | URL, _init?: RequestInit) => textResponse(""),
) {
  const fetchSpy = vi.fn(impl);
  global.fetch = withFetchPreconnect(fetchSpy);
  return fetchSpy;
}

async function createWebFetchToolForTest(params?: {
  firecrawlApiKey?: string;
  globalSsrFPolicy?: {
    allowPrivateNetwork?: boolean;
    dangerouslyAllowPrivateNetwork?: boolean;
    allowedHostnames?: string[];
    hostnameAllowlist?: string[];
    allowRfc2544BenchmarkRange?: boolean;
  };
  agentSsrFPolicy?: {
    allowPrivateNetwork?: boolean;
    dangerouslyAllowPrivateNetwork?: boolean;
    allowedHostnames?: string[];
    hostnameAllowlist?: string[];
    allowRfc2544BenchmarkRange?: boolean;
  };
  cacheTtlMinutes?: number;
}) {
  const { createWebFetchTool } = await import("./web-tools.js");
  return createWebFetchTool({
    config: {
      plugins: params?.firecrawlApiKey
        ? {
            entries: {
              firecrawl: {
                config: {
                  webFetch: {
                    apiKey: params.firecrawlApiKey,
                  },
                },
              },
            },
          }
        : undefined,
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: params?.cacheTtlMinutes ?? 0,
            ssrfPolicy: params?.globalSsrFPolicy,
            ...(params?.firecrawlApiKey ? { provider: "firecrawl" } : {}),
          },
        },
      },
    },
    agentTools: params?.agentSsrFPolicy
      ? {
          web: {
            fetch: {
              ssrfPolicy: params.agentSsrFPolicy,
            },
          },
        }
      : undefined,
    lookupFn: lookupMock,
  });
}

async function expectBlockedUrl(
  tool: Awaited<ReturnType<typeof createWebFetchToolForTest>>,
  url: string,
  expectedMessage: RegExp,
) {
  await expect(tool?.execute?.("call", { url })).rejects.toThrow(expectedMessage);
}

describe("web_fetch SSRF protection", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation((hostname) =>
      resolvePinnedHostname(hostname, lookupMock),
    );
  });

  afterEach(() => {
    global.fetch = priorFetch;
    lookupMock.mockClear();
    vi.restoreAllMocks();
  });

  it("blocks localhost hostnames before fetch/firecrawl", async () => {
    const fetchSpy = setMockFetch();
    const tool = await createWebFetchToolForTest({
      firecrawlApiKey: "firecrawl-test", // pragma: allowlist secret
    });

    await expectBlockedUrl(tool, "http://localhost/test", /Blocked hostname/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks private IP literals without DNS", async () => {
    const fetchSpy = setMockFetch();
    const tool = await createWebFetchToolForTest();

    const cases = ["http://127.0.0.1/test", "http://[::ffff:127.0.0.1]/"] as const;
    for (const url of cases) {
      await expectBlockedUrl(tool, url, /private|internal|blocked/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks when DNS resolves to private addresses", async () => {
    lookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === "public.test") {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      return [{ address: "10.0.0.5", family: 4 }];
    });

    const fetchSpy = setMockFetch();
    const tool = await createWebFetchToolForTest();

    await expectBlockedUrl(tool, "https://private.test/resource", /private|internal|blocked/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks redirects to private hosts", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const fetchSpy = setMockFetch().mockResolvedValueOnce(
      redirectResponse("http://127.0.0.1/secret"),
    );
    const tool = await createWebFetchToolForTest({
      firecrawlApiKey: "firecrawl-test", // pragma: allowlist secret
    });

    await expectBlockedUrl(tool, "https://example.com", /private|internal|blocked/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("allows public hosts", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    setMockFetch().mockResolvedValue(textResponse("ok"));
    const tool = await createWebFetchToolForTest();

    const result = await tool?.execute?.("call", { url: "https://example.com" });
    expect(result?.details).toMatchObject({
      status: 200,
      extractor: "raw",
    });
  });

  it("allows RFC2544 benchmark-range URLs only when web_fetch ssrfPolicy opts in", async () => {
    const url = "http://198.18.0.153/file";
    lookupMock.mockResolvedValue([{ address: "198.18.0.153", family: 4 }]);

    const deniedTool = await createWebFetchToolForTest({ cacheTtlMinutes: 1 });
    await expectBlockedUrl(deniedTool, url, /private|internal|blocked/i);

    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("benchmark ok"));
    const allowedTool = await createWebFetchToolForTest({
      globalSsrFPolicy: { allowRfc2544BenchmarkRange: true },
      cacheTtlMinutes: 1,
    });

    const allowed = await allowedTool?.execute?.("call", { url });
    expect(allowed?.details).toMatchObject({
      status: 200,
      extractor: "raw",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const stricterTool = await createWebFetchToolForTest({ cacheTtlMinutes: 1 });
    await expectBlockedUrl(stricterTool, url, /private|internal|blocked/i);
  });

  it("allows private-network targets when a named agent opts in", async () => {
    const url = "http://127.0.0.1/private";
    const deniedTool = await createWebFetchToolForTest({
      globalSsrFPolicy: { dangerouslyAllowPrivateNetwork: false },
    });
    await expectBlockedUrl(deniedTool, url, /private|internal|blocked/i);

    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("agent ok"));
    const allowedTool = await createWebFetchToolForTest({
      globalSsrFPolicy: { dangerouslyAllowPrivateNetwork: false },
      agentSsrFPolicy: { dangerouslyAllowPrivateNetwork: true },
    });

    const result = await allowedTool?.execute?.("call", { url });
    expect(result?.details).toMatchObject({ status: 200, extractor: "raw" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("allows narrow hostname exceptions from a named agent", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("hostname ok"));
    const tool = await createWebFetchToolForTest({
      globalSsrFPolicy: { allowedHostnames: ["global-only.internal"] },
      agentSsrFPolicy: { allowedHostnames: ["matrix.home.arpa"] },
    });

    const result = await tool?.execute?.("call", { url: "https://matrix.home.arpa/status" });
    expect(result?.details).toMatchObject({ status: 200, extractor: "raw" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not reuse broader-policy cache entries for stricter policies", async () => {
    const url = "http://198.18.0.153/file";
    lookupMock.mockResolvedValue([{ address: "198.18.0.153", family: 4 }]);

    const fetchSpy = setMockFetch().mockResolvedValue(textResponse("broad cache"));
    const broadTool = await createWebFetchToolForTest({
      agentSsrFPolicy: { dangerouslyAllowPrivateNetwork: true },
      cacheTtlMinutes: 1,
    });
    await broadTool?.execute?.("call", { url });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const strictTool = await createWebFetchToolForTest({ cacheTtlMinutes: 1 });
    await expectBlockedUrl(strictTool, url, /private|internal|blocked/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
