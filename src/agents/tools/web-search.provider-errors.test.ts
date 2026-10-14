import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  PluginWebSearchProviderEntry,
  WebSearchProviderPlugin,
} from "../../plugins/web-provider-types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { executeWebSearchCandidates } from "../../web-search/runtime-execution.js";
import type { RunWebSearchParams } from "../../web-search/runtime-types.js";
import { createWebSearchTool } from "./web-search.js";

const mocks = vi.hoisted(() => ({ runWebSearch: vi.fn(), endpoint: vi.fn() }));
vi.mock("../../web-search/runtime.js", () => ({ runWebSearch: mocks.runWebSearch }));
vi.mock("./web-guarded-fetch.js", () => ({ withTrustedWebToolsEndpoint: mocks.endpoint }));

const API_KEY = "pplx-synthetic-search-status-key";
const BODY = `private upstream diagnostic for ${API_KEY}`;
const config: OpenClawConfig = {
  tools: { web: { search: { provider: "perplexity" } } },
  plugins: { entries: { perplexity: { config: { webSearch: { apiKey: API_KEY } } } } },
};
let provider: PluginWebSearchProviderEntry;

beforeAll(async () => {
  const facade = await loadBundledPluginFacade<{
    createPerplexityWebSearchProvider: () => WebSearchProviderPlugin;
  }>({
    pluginId: "perplexity",
    artifactBasename: "web-search-provider.js",
  });
  provider = { ...facade.createPerplexityWebSearchProvider(), pluginId: "perplexity" };
});

beforeEach(() => {
  mocks.endpoint.mockReset();
  mocks.runWebSearch.mockReset().mockImplementationOnce((params: RunWebSearchParams) =>
    executeWebSearchCandidates({
      ...params,
      candidates: [provider],
      searchConfig: { cacheTtlMinutes: 0 },
      allowFallback: false,
    }),
  );
});

it("web_search preserves provider HTTP 403 guidance without exposing the response body", async () => {
  mocks.endpoint.mockImplementationOnce(
    async (_params: unknown, run: (context: { response: Response }) => Promise<unknown>) =>
      run({ response: new Response(BODY, { status: 403 }) }),
  );
  const result = await createWebSearchTool({ config })?.execute("search-http-error", {
    query: "synthetic query",
  });

  expect(result?.details).toMatchObject({
    kind: "error",
    provider: "perplexity",
    message: expect.stringContaining("HTTP 403"),
  });
  expect(JSON.stringify(result)).toContain("credentials");
  expect(JSON.stringify(result)).not.toContain("private upstream diagnostic");
  expect(JSON.stringify(result)).not.toContain(API_KEY);
});

it.each([
  { timeoutMs: 90_000, message: "Search timed out after 90s." },
  { timeoutMs: 1_250, message: "Search timed out after 1250ms." },
  { timeoutMs: undefined, message: "Search timed out." },
  { timeoutMs: 0, message: "Search timed out." },
  { timeoutMs: BODY, message: "Search timed out." },
])(
  "web_search preserves a provider timeout with budget $timeoutMs without private diagnostics",
  async ({ timeoutMs, message }) => {
    const cause = Object.assign(new Error(BODY), { name: "TimeoutError", timeoutMs });
    mocks.endpoint.mockRejectedValueOnce(cause);

    const result = await createWebSearchTool({ config })?.execute("search-timeout", {
      query: "synthetic query",
    });

    expect(result?.details).toMatchObject({
      kind: "error",
      provider: "perplexity",
      message: expect.stringContaining(message),
    });
    expect(JSON.stringify(result)).not.toContain("configuration");
    expect(JSON.stringify(result)).not.toContain(BODY);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  },
);

it("web_search keeps connection failures distinct from deadline expiry", async () => {
  mocks.endpoint.mockRejectedValueOnce(new Error("fetch failed"));
  const result = await createWebSearchTool({ config })?.execute("search-connection-error", {
    query: "synthetic query",
  });

  expect(result?.details).toMatchObject({
    kind: "error",
    provider: "perplexity",
    message: expect.stringContaining("configuration and connection"),
  });
  expect(JSON.stringify(result)).not.toContain("Search timed out");
});
