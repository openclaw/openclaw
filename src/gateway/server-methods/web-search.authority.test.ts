import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginWebSearchProviderEntry, WebSearchProviderPlugin } from "../../plugins/types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  profile: vi.fn(),
  providers: [] as PluginWebSearchProviderEntry[],
  beforeImport: vi.fn<() => Promise<void>>(),
}));
vi.mock("./users-profile-access.js", () => ({ resolveAuthenticatedProfileId: mocks.profile }));
vi.mock("./web-search-status.js", () => ({ prepareWebSearchStatus: mocks.prepare }));
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

function request(): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "search-authority", method: "webSearch.test" },
    params: { query: "synthetic authority probe" },
    client: { connect: { scopes: ["operator.admin"] } },
    context: { getRuntimeConfig: () => config },
    respond: vi.fn(),
  } as unknown as GatewayRequestHandlerOptions;
}

function searchResponse() {
  return Response.json({
    search_id: "synthetic-search",
    results: [{ title: "Source", url: "https://example.com/source", excerpts: ["An excerpt"] }],
  });
}

beforeAll(async () => {
  const { createParallelWebSearchProvider } = await loadBundledPluginFacade<{
    createParallelWebSearchProvider: () => WebSearchProviderPlugin;
  }>({ pluginId: "parallel", artifactBasename: "web-search-contract-api.js" });
  mocks.providers = [{ ...createParallelWebSearchProvider(), pluginId: "parallel" }];
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.beforeImport.mockResolvedValue(undefined);
  mocks.profile.mockReturnValue("original-profile");
  config = {
    tools: { web: { search: { provider: "parallel", cacheTtlMinutes: 0 } } },
    plugins: {
      entries: {
        parallel: { config: { webSearch: { apiKey: "synthetic-parallel-key" } } },
      },
    },
  };
  mocks.prepare.mockImplementation(async () => ({
    config,
    status: {
      route: { kind: "managed", provider: "parallel", label: "Parallel", testable: true },
    },
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("Search settings live provider authority", () => {
  it.each([
    ["lazy import", "client"],
    ["lazy import", "profile"],
    ["lazy import", "config"],
    ["redirect", "client"],
    ["redirect", "profile"],
    ["redirect", "config"],
  ] as const)(
    "sends no further requests after %s preparation loses %s authority",
    async (stage, loss) => {
      const entered = createDeferred();
      const release = createDeferred();
      const pause = async () => {
        entered.resolve();
        await release.promise;
      };
      const fetch = vi.fn(async () => searchResponse());
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
      const options = request();
      const pending = webSearchHandlers["webSearch.test"]!(options);
      await entered.promise;
      if (loss === "client") {
        options.client!.invalidated = true;
      } else if (loss === "profile") {
        mocks.profile.mockReturnValue("replacement-profile");
      } else {
        config = { tools: { web: { search: { enabled: false } } } };
      }
      release.resolve();
      await pending;
      expect(fetch).toHaveBeenCalledTimes(stage === "lazy import" ? 0 : 1);
      expect(options.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
    },
  );

  it("keeps an active lazy provider request and its redirect usable", async () => {
    const fetch = vi.fn(async () => searchResponse());
    fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: { location: "https://api.parallel.ai/v1/redirected-search" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const options = request();
    await webSearchHandlers["webSearch.test"]!(options);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(options.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "ok", provider: "parallel" }),
      undefined,
    );
  });
});
