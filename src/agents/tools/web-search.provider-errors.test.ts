import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
let observedFailure: unknown;

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
  observedFailure = undefined;
  mocks.runWebSearch.mockReset().mockImplementationOnce((params: RunWebSearchParams) =>
    executeWebSearchCandidates({
      ...params,
      candidates: [provider],
      searchConfig: { cacheTtlMinutes: 0 },
      allowFallback: false,
    }).catch((error: unknown) => {
      observedFailure = error;
      throw error;
    }),
  );
});

describe("provider HTTP errors through web_search", () => {
  it.each([401, 403, 429])(
    "preserves HTTP %i guidance without exposing the response body",
    async (httpStatus) => {
      mocks.endpoint.mockImplementationOnce(
        async (_params: unknown, run: (context: { response: Response }) => Promise<unknown>) =>
          run({ response: new Response(BODY, { status: httpStatus }) }),
      );
      const result = await createWebSearchTool({ config })?.execute("search-http-error", {
        query: "synthetic query",
      });

      expect(observedFailure).toMatchObject({
        provider: "perplexity",
        cause: { status: httpStatus, statusCode: httpStatus },
      });
      expect(result?.details).toMatchObject({
        kind: "error",
        provider: "perplexity",
        message: expect.stringContaining(`HTTP ${httpStatus}`),
      });
      expect(JSON.stringify(result)).toContain(httpStatus === 429 ? "quota" : "credentials");
      expect(JSON.stringify(result)).not.toContain("private upstream diagnostic");
      expect(JSON.stringify(result)).not.toContain(API_KEY);
    },
  );

  it("preserves cancellation after failed response headers", async () => {
    const controller = new AbortController();
    const reason = new Error("Search cancelled after headers");
    mocks.endpoint.mockImplementationOnce(
      async (_params: unknown, run: (context: { response: Response }) => Promise<unknown>) => {
        controller.abort(reason);
        return run({ response: new Response(BODY, { status: 401 }) });
      },
    );
    await expect(
      createWebSearchTool({ config })?.execute(
        "cancel-search",
        { query: "synthetic query" },
        controller.signal,
      ),
    ).rejects.toBe(reason);
  });
});
