import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSearchStatusResult } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  search: vi.fn(),
  assertSecret: vi.fn(),
  profile: vi.fn(),
  assertProfile: vi.fn(),
}));
vi.mock("./users-profile-access.js", () => ({
  prepareAuthenticatedProfile: async () => ({
    profileId: mocks.profile(),
    assertCurrent: mocks.assertProfile,
  }),
}));
vi.mock("./web-search-status.js", () => ({ prepareWebSearchStatus: mocks.prepare }));
vi.mock("../../web-search/runtime.js", () => ({ runWebSearch: mocks.search }));
vi.mock("../../secrets/runtime-degraded-state.js", () => ({
  assertSecretOwnerAvailable: mocks.assertSecret,
}));
import { webSearchHandlers } from "./web-search.js";

let config: OpenClawConfig;
let searchStatus: WebSearchStatusResult;
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
async function invoke(options: GatewayRequestHandlerOptions) {
  await webSearchHandlers[options.req.method]!(options);
  return vi.mocked(options.respond);
}
async function expectResult(options: GatewayRequestHandlerOptions, result: unknown) {
  const respond = await invoke(options);
  expect(respond).toHaveBeenCalledWith(true, result, undefined);
  return respond;
}
async function expectFailure(
  options: GatewayRequestHandlerOptions,
  code: "INVALID_REQUEST" | "UNAVAILABLE",
) {
  const respond = await invoke(options);
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code }));
  return respond;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.profile.mockReturnValue(undefined);
  mocks.assertProfile.mockReset();
  config = { tools: { web: { search: { provider: "example", cacheTtlMinutes: 15 } } } };
  searchStatus = {
    enabled: true,
    provider: "example",
    agentId: "main",
    model: { provider: "local", id: "local-model", runtime: "openclaw" },
    providers: [],
    route: { kind: "managed", provider: "example", label: "Example Search", testable: true },
  };
  mocks.prepare.mockImplementation(async () => ({
    status: searchStatus,
    config,
    agentDir: "/synthetic/agent",
  }));
  mocks.search.mockResolvedValue({
    provider: "example",
    result: {
      results: [{ title: "A source", url: "https://example.com/source", description: "A snippet" }],
    },
  });
});

describe("Search settings Gateway boundary", () => {
  it("returns settings and rejects incomplete or unknown request fields", async () => {
    await expectResult(request("webSearch.status"), searchStatus);
    for (const params of [
      { modelId: "model" },
      { modelProvider: "local", modelId: " " },
      { extra: true },
    ]) {
      await expectFailure(request("webSearch.status", params), "INVALID_REQUEST");
    }
  });

  it.each(["sources", "answer"])(
    "normalizes %s through the search owner with cache bypass",
    async (kind) => {
      if (kind === "answer") {
        mocks.search.mockResolvedValue({
          provider: "example",
          result: {
            content: "A grounded answer",
            citations: [
              { url: "https://example.com/source", title: "Source" },
              "javascript:alert(1)",
            ],
          },
        });
      }
      const query = kind === "sources" ? " source query " : "query";
      await expectResult(
        request("webSearch.test", { query }),
        expect.objectContaining({
          provider: "example",
          status: "ok",
          latencyMs: expect.any(Number),
          cached: false,
          ...(kind === "sources"
            ? {
                results: [
                  { title: "A source", url: "https://example.com/source", snippet: "A snippet" },
                ],
              }
            : {
                content: "A grounded answer",
                citations: [{ url: "https://example.com/source", title: "Source" }],
              }),
        }),
      );
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
    },
  );

  it("tests only the explicitly named configured managed service beside an external harness", async () => {
    searchStatus.route = {
      kind: "external",
      provider: "custom-harness",
      label: "Harness controls search",
      testable: false,
      reason: "Test this route in chat.",
    };
    searchStatus.testProvider = { id: "example", label: "Example Search" };
    await expectFailure(request("webSearch.test", { query: "query" }), "INVALID_REQUEST");
    expect(mocks.search).not.toHaveBeenCalled();
    await expectFailure(
      request("webSearch.test", { query: "query", providerId: "other" }),
      "INVALID_REQUEST",
    );
    expect(mocks.search).not.toHaveBeenCalled();
    await expectResult(
      request("webSearch.test", { query: "query", providerId: "example" }),
      expect.objectContaining({ provider: "example", status: "ok" }),
    );
  });

  it.each(["read", "profile", "admin"])(
    "requires current %s authority across preparation",
    async (authority) => {
      if (authority === "admin") {
        const readOnly = request("webSearch.test", { query: "query" });
        readOnly.client!.connect.scopes = ["operator.read"];
        await invoke(readOnly);
        expect(mocks.prepare).not.toHaveBeenCalled();
      }
      if (authority === "profile") {
        mocks.profile.mockReturnValue("original");
      }
      const revoked = request(
        authority === "read" ? "webSearch.status" : "webSearch.test",
        authority === "read" ? {} : { query: "query" },
      );
      mocks.prepare.mockImplementationOnce(async () => {
        if (authority === "profile") {
          mocks.assertProfile.mockImplementation(() => {
            throw new Error("profile authority changed");
          });
        } else {
          revoked.client!.invalidated = true;
        }
        return { status: searchStatus, config, agentDir: "/synthetic/agent" };
      });
      await expectFailure(revoked, "UNAVAILABLE");
      expect(mocks.search).not.toHaveBeenCalled();
    },
  );

  it("rejects configuration changes before invoking the provider and discards results after access is revoked", async () => {
    const original = config;
    mocks.prepare.mockImplementationOnce(async () => {
      config = { tools: { web: { search: { enabled: false } } } };
      return { status: searchStatus, config: original, agentDir: "/synthetic/agent" };
    });
    await expectFailure(request("webSearch.test", { query: "query" }), "UNAVAILABLE");
    expect(mocks.search).not.toHaveBeenCalled();
    const revoked = request("webSearch.test", { query: "query" });
    mocks.search.mockImplementationOnce(async () => {
      revoked.client!.invalidated = true;
      return { provider: "example", result: { content: "Private result" } };
    });
    const respond = await expectFailure(revoked, "UNAVAILABLE");
    expect(JSON.stringify(respond.mock.calls)).not.toContain("Private result");
  });

  it.each([
    { failure: new Error("401 reflected-private-key"), expected: "authenticate" },
    { failure: new Error("429 reflected-private-key"), expected: "rate limit" },
    { failure: new Error("Timeout reflected-private-key"), expected: "timed out" },
    { failure: new Error("Connection refused reflected-private-key"), expected: "connectivity" },
  ])(
    "reports actionable failures without reflected provider diagnostics: $expected",
    async ({ failure, expected }) => {
      mocks.search.mockRejectedValueOnce(failure);
      const respond = await expectResult(
        request("webSearch.test", { query: "query" }),
        expect.objectContaining({ status: "error", error: expect.stringContaining(expected) }),
      );
      expect(JSON.stringify(respond.mock.calls)).not.toContain("reflected-private-key");
    },
  );

  it("treats provider error payloads as failures and never passes through arbitrary raw data", async () => {
    for (const result of [
      { error: "missing_api_key", message: "private-value" },
      { debug: "private-value" },
    ]) {
      mocks.search.mockResolvedValueOnce({ provider: "example", result });
      const respond = await expectResult(
        request("webSearch.test", { query: "query" }),
        expect.objectContaining({ status: "error" }),
      );
      expect(JSON.stringify(respond.mock.calls)).not.toContain("private-value");
    }
  });
});
