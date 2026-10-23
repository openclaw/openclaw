import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  PluginWebSearchProviderEntry,
  WebSearchProviderPlugin,
} from "../../plugins/web-provider-types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { OAuthRefreshFailureError } from "../auth-profiles/oauth-refresh-failure.js";
import { createWebSearchTool } from "./web-search.js";

const mocks = vi.hoisted(() => ({ endpoint: vi.fn() }));
// mock-isolation: Exercise the real search runtime against one synthetic provider registry.
vi.mock("../../plugins/bundled-discovery-state.js", () => ({
  prepareBundledDiscoveryMode: async () => () => {},
  readBundledDiscoveryModeMemoized: () => undefined,
}));
vi.mock("../../plugins/web-search-providers.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/web-search-providers.runtime.js")>()),
  resolvePluginWebSearchProviders: () => [provider],
  resolveRuntimeWebSearchProviders: () => [provider],
}));
vi.mock("../../plugins/plugin-registry-contributions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-registry-contributions.js")>()),
  resolveManifestContractOwnerPluginId: () => "perplexity",
}));
vi.mock("./web-guarded-fetch.js", () => ({ withTrustedWebToolsEndpoint: mocks.endpoint }));

const API_KEY = "pplx-synthetic-search-status-key";
const BODY = `private upstream diagnostic for ${API_KEY}`;
const config: OpenClawConfig = {
  tools: { web: { search: { provider: "perplexity", cacheTtlMinutes: 0 } } },
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
  clearRuntimeConfigSnapshot();
  mocks.endpoint.mockReset();
});

async function expectFailure(message: string) {
  const result = await createWebSearchTool({ config })?.execute("search-error", {
    query: "synthetic query",
  });
  expect(result?.details).toMatchObject({
    kind: "error",
    provider: "perplexity",
    message: expect.stringContaining(message),
  });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(BODY);
  expect(serialized).not.toContain(API_KEY);
  return serialized;
}

it("web_search preserves provider HTTP 403 guidance without exposing the response body", async () => {
  mocks.endpoint.mockImplementationOnce(
    async (_params: unknown, run: (context: { response: Response }) => Promise<unknown>) =>
      run({ response: new Response(BODY, { status: 403 }) }),
  );
  const serialized = await expectFailure("HTTP 403");
  expect(serialized).toContain("credentials");
  expect(serialized).not.toContain("private upstream diagnostic");
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

    expect(await expectFailure(message)).not.toContain("configuration");
  },
);

it("web_search keeps connection failures distinct from deadline expiry", async () => {
  mocks.endpoint.mockRejectedValueOnce(new Error("fetch failed"));
  expect(await expectFailure("configuration and connection")).not.toContain("Search timed out");
});

it.each([
  { reason: "invalid_grant" as const, state: "expired and could not be refreshed" },
  { reason: null, state: "could not be refreshed" },
])(
  "web_search names a dead search sign-in and its fix without account details ($reason)",
  async ({ reason, state }) => {
    mocks.endpoint.mockRejectedValueOnce(
      new OAuthRefreshFailureError({
        provider: "xai",
        profileId: "xai:owner@example.test",
        message: `OAuth token refresh failed for xai: ${BODY}`,
        reason,
      }),
    );
    const serialized = await expectFailure(
      `Search failed: this search provider's xai sign-in ${state}. The Gateway owner can fix it by sending \`/login xai\` in a private chat or Control UI session, or by running \`openclaw models auth login --provider xai\`. Other routes, such as web_fetch, may still work.`,
    );
    expect(serialized).not.toContain("configuration and connection");
    expect(serialized).not.toContain("tell the user");
    expect(serialized).not.toContain("owner@example.test");
  },
);
