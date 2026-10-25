import "./web-search-runtime.test-support.js";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginWebSearchProviderEntry, WebSearchProviderPlugin } from "../../plugins/types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
const { preparedWebSearchCatalog: preparedCatalog, webSearchRuntimeMocks: runtimeMocks } =
  await import("./web-search-runtime.test-support.js");

const mocks = vi.hoisted(() => ({
  assertProfile: vi.fn(),
  providers: [] as PluginWebSearchProviderEntry[],
  beforeImport: vi.fn<() => Promise<void>>(),
}));
// mock-isolation: Control profile revocation without querying a live identity database.
vi.mock("./users-profile-access.js", () => ({
  prepareAuthenticatedProfile: async () => ({
    profileId: "original-profile",
    assertCurrent: mocks.assertProfile,
  }),
}));
// mock-isolation: Expose the real provider facade as status input without setup discovery.
vi.mock("../../flows/search-setup.js", () => ({
  listSearchProviderOptions: () => mocks.providers,
}));
vi.mock("../../plugins/plugin-registry-contributions.js", () => ({
  resolveManifestContractOwnerPluginId: () => "parallel",
}));
vi.mock("../../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: () => mocks.providers,
  resolveRuntimeWebSearchProviders: () => mocks.providers,
}));
vi.mock("openclaw/plugin-sdk/lazy-runtime", () => ({
  createLazyRuntimeModule: (importer: () => Promise<unknown>) => async () => {
    await mocks.beforeImport();
    return await importer();
  },
}));
import { webSearchHandlers } from "./web-search.js";

let config: OpenClawConfig;

beforeAll(async () => {
  const { createParallelWebSearchProvider } = await loadBundledPluginFacade<{
    createParallelWebSearchProvider: () => WebSearchProviderPlugin;
  }>({ pluginId: "parallel", artifactBasename: "web-search-contract-api.js" });
  mocks.providers = [{ ...createParallelWebSearchProvider(), pluginId: "parallel" }];
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.beforeImport.mockResolvedValue(undefined);
  mocks.assertProfile.mockReset();
  config = {
    tools: { web: { search: { provider: "parallel", cacheTtlMinutes: 0 } } },
    plugins: { entries: { parallel: { config: { webSearch: { apiKey: "synthetic" } } } } },
  };
  runtimeMocks.catalog.mockImplementation(async () => preparedCatalog());
  runtimeMocks.runtime.mockReturnValue({ id: "openclaw" });
});

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["lazy import", "client"],
  ["redirect", "profile"],
  ["redirect", "config"],
  ["redirect", "none"],
] as const)("Search provider authority at %s with %s revocation", async (stage, loss) => {
  const entered = createDeferred();
  const release = createDeferred();
  const pause = async () => {
    entered.resolve();
    await release.promise;
  };
  const fetch = vi.fn(async () =>
    Response.json({
      results: [{ title: "Source", url: "https://example.com", excerpts: ["text"] }],
    }),
  );
  if (stage === "lazy import") {
    mocks.beforeImport.mockImplementationOnce(pause);
  } else {
    fetch.mockImplementationOnce(async () => {
      await pause();
      return new Response(null, {
        status: 307,
        headers: { location: "https://api.parallel.ai/v1/redirected-search" },
      });
    });
  }
  vi.stubGlobal("fetch", fetch);
  const options = {
    req: { type: "req", id: "search-authority", method: "webSearch.test" },
    params: { query: "synthetic authority probe" },
    client: { connect: { scopes: ["operator.admin"] } },
    context: { getRuntimeConfig: () => config },
    respond: vi.fn(),
  } as unknown as GatewayRequestHandlerOptions;
  const pending = webSearchHandlers["webSearch.test"]!(options);
  await entered.promise;
  if (loss === "client") {
    options.client!.invalidated = true;
  } else if (loss === "profile") {
    mocks.assertProfile.mockImplementation(() => {
      throw new Error("profile authority changed");
    });
  } else if (loss === "config") {
    config = { tools: { web: { search: { enabled: false } } } };
  }
  release.resolve();
  await pending;
  const succeeded = loss === "none";
  expect(fetch).toHaveBeenCalledTimes(stage === "lazy import" ? 0 : succeeded ? 2 : 1);
  expect(options.respond).toHaveBeenCalledWith(
    succeeded,
    succeeded ? expect.objectContaining({ status: "ok", provider: "parallel" }) : undefined,
    succeeded ? undefined : expect.objectContaining({ code: "UNAVAILABLE" }),
  );
});
