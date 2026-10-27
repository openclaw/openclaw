import "./web-search-runtime.test-support.js";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createWebSearchTestProvider } from "../../test-utils/web-provider-runtime.test-helpers.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
const { preparedWebSearchCatalog: preparedCatalog, webSearchRuntimeMocks: runtimeMocks } =
  await import("./web-search-runtime.test-support.js");

const mocks = vi.hoisted(() => ({
  prepareProfile: vi.fn(),
  search: vi.fn(),
  assertSecret: vi.fn(),
  assertProfile: vi.fn(),
}));
// mock-isolation: Control requester revocation without opening the live identity database.
vi.mock("./users-profile-access.js", () => ({
  prepareAuthenticatedProfile: mocks.prepareProfile,
}));
// mock-isolation: Synthetic provider discovery is input to the real status projection.
vi.mock("../../flows/search-setup.js", () => ({
  listSearchProviderOptions: () => [exampleProvider],
}));
// mock-isolation: Fix provider inputs while retaining the existing search-effect spy.
vi.mock("../../web-search/runtime.js", () => ({
  runWebSearch: mocks.search,
  isWebSearchProviderConfigured: () => true,
  listConfiguredWebSearchProviders: () => [exampleProvider],
  resolveWebSearchProviderId: () => "example",
}));
vi.mock("../../secrets/runtime-degraded-state.js", () => ({
  assertSecretOwnerAvailable: mocks.assertSecret,
}));
import { webSearchHandlers } from "./web-search.js";

let config: OpenClawConfig;
let profileId: string | undefined;
const source = { title: "A source", url: "https://example.com/source" };
const citation = { url: source.url, title: "Source" };
const sourceResult = { results: [{ ...source, description: "A snippet" }] };
const answer = { content: "A grounded answer", citations: [citation] };
const exampleProvider = {
  ...createWebSearchTestProvider({
    id: "example",
    pluginId: "example",
    credentialPath: "plugins.entries.example.config.webSearch.apiKey",
    getConfiguredCredentialValue: () => "synthetic",
  }),
  label: "Example Search",
  envVars: [],
};
function request(
  method: "webSearch.status" | "webSearch.test",
  params: Record<string, unknown> = {},
) {
  return {
    req: { type: "req", id: "search-test", method },
    params,
    client: { connect: { scopes: ["operator.admin"] } },
    context: { getRuntimeConfig: () => config },
    respond: vi.fn(),
  } as unknown as GatewayRequestHandlerOptions;
}
async function invoke(options: GatewayRequestHandlerOptions, expected: unknown[]) {
  await webSearchHandlers[options.req.method]!(options);
  const respond = vi.mocked(options.respond);
  expect(respond).toHaveBeenCalledWith(...expected);
  return respond;
}
const expectResult = (options: GatewayRequestHandlerOptions, result: unknown) =>
  invoke(options, [true, result, undefined]);
const probe = (params: Record<string, unknown> = {}) =>
  request("webSearch.test", { query: "query", ...params });
const expectProbe = (result: Record<string, unknown>, params: Record<string, unknown> = {}) =>
  expectResult(probe(params), expect.objectContaining(result));
const expectFailure = (
  options: GatewayRequestHandlerOptions,
  code: "INVALID_REQUEST" | "UNAVAILABLE",
) => invoke(options, [false, undefined, expect.objectContaining({ code })]);
beforeEach(() => {
  vi.clearAllMocks();
  profileId = undefined;
  mocks.assertProfile.mockReset();
  config = { tools: { web: { search: { provider: "example", cacheTtlMinutes: 15 } } } };
  mocks.prepareProfile.mockImplementation(async () => ({
    profileId,
    assertCurrent: mocks.assertProfile,
  }));
  runtimeMocks.catalog.mockImplementation(async () => preparedCatalog());
  runtimeMocks.runtime.mockReturnValue({ id: "openclaw" });
  mocks.search.mockResolvedValue({ provider: "example", result: sourceResult });
});

it("rejects incomplete or unknown request fields", async () => {
  for (const params of [
    { modelId: "model" },
    { modelProvider: "local", modelId: " " },
    { extra: true },
  ]) {
    await expectFailure(request("webSearch.status", params), "INVALID_REQUEST");
  }
});

it.each([
  ["sources", sourceResult, { results: [{ ...source, snippet: "A snippet" }] }],
  ["answer", { ...answer, citations: [citation, "javascript:alert(1)"] }, answer],
] as const)("normalizes %s with cache bypass", async (_kind, result, expected) => {
  const query = " source query ";
  mocks.search.mockResolvedValue({ provider: "example", result });
  const resultShape = {
    provider: "example",
    status: "ok",
    latencyMs: expect.any(Number),
    cached: false,
    ...expected,
  };
  await expectProbe(resultShape, { query });
  expect(mocks.search).toHaveBeenCalledWith(
    expect.objectContaining({
      providerId: "example",
      agentDir: "/synthetic/agent",
      preferInputConfig: true,
      args: { query: query.trim(), count: 5 },
      signal: expect.any(AbortSignal),
      config: { tools: { web: { search: { provider: "example", cacheTtlMinutes: 0 } } } },
    }),
  );
  expect(config.tools?.web?.search?.cacheTtlMinutes).toBe(15);
});

it("probes only the configured service beside an external harness", async () => {
  runtimeMocks.runtime.mockReturnValue({ id: "custom-harness" });
  await expectFailure(probe(), "INVALID_REQUEST");
  expect(mocks.search).not.toHaveBeenCalled();
  await expectFailure(probe({ providerId: "other" }), "INVALID_REQUEST");
  expect(mocks.search).not.toHaveBeenCalled();
  await expectProbe({ provider: "example", status: "ok" }, { providerId: "example" });
});

it.each(["read", "profile", "admin"])("rechecks %s authority", async (authority) => {
  if (authority === "admin") {
    const readOnly = probe();
    readOnly.client!.connect.scopes = ["operator.read"];
    await expectFailure(readOnly, "INVALID_REQUEST");
    expect(runtimeMocks.catalog).not.toHaveBeenCalled();
    expect(mocks.prepareProfile).not.toHaveBeenCalled();
  }
  if (authority === "profile") {
    profileId = "original";
  }
  const revoked = request(
    authority === "read" ? "webSearch.status" : "webSearch.test",
    authority === "read" ? {} : { query: "query" },
  );
  runtimeMocks.catalog.mockImplementationOnce(async () => {
    if (authority === "profile") {
      mocks.assertProfile.mockImplementation(() => {
        throw new Error("profile authority changed");
      });
    } else {
      revoked.client!.invalidated = true;
    }
    return preparedCatalog();
  });
  await expectFailure(revoked, "UNAVAILABLE");
  expect(mocks.search).not.toHaveBeenCalled();
});

it("rejects config drift before search and revocation after search", async () => {
  const original = config;
  runtimeMocks.catalog.mockImplementationOnce(async () => {
    config = { tools: { web: { search: { enabled: false } } } };
    return preparedCatalog();
  });
  await expectFailure(probe(), "UNAVAILABLE");
  expect(mocks.search).not.toHaveBeenCalled();
  config = original;
  const revoked = probe();
  mocks.search.mockImplementationOnce(async () => {
    revoked.client!.invalidated = true;
    return { provider: "example", result: { content: "Private result" } };
  });
  const respond = await expectFailure(revoked, "UNAVAILABLE");
  expect(JSON.stringify(respond.mock.calls)).not.toContain("Private result");
});

it.each([
  ["401", "authenticate"],
  ["429", "rate limit"],
  ["Timeout", "timed out"],
  ["Connection refused", "connectivity"],
])("redacts %s failures with actionable guidance", async (failure, expected) => {
  mocks.search.mockRejectedValueOnce(new Error(`${failure} reflected-private-key`));
  const respond = await expectProbe({ status: "error", error: expect.stringContaining(expected) });
  expect(JSON.stringify(respond.mock.calls)).not.toContain("reflected-private-key");
});

it("redacts error payloads and unsupported raw results", async () => {
  for (const result of [
    { error: "missing_api_key", message: "private-value" },
    { debug: "private-value" },
  ]) {
    mocks.search.mockResolvedValueOnce({ provider: "example", result });
    const respond = await expectProbe({ status: "error" });
    expect(JSON.stringify(respond.mock.calls)).not.toContain("private-value");
  }
});
