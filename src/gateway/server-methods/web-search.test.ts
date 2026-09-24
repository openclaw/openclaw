import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSearchStatusResult } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  search: vi.fn(),
  assertSecret: vi.fn(),
  profile: vi.fn(),
}));
vi.mock("./users-profile-access.js", () => ({ resolveAuthenticatedProfileId: mocks.profile }));
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
beforeEach(() => {
  vi.clearAllMocks();
  mocks.profile.mockReturnValue(undefined);
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
    expect(await invoke(request("webSearch.status"))).toHaveBeenCalledWith(
      true,
      searchStatus,
      undefined,
    );
    for (const params of [
      { modelId: "model" },
      { modelProvider: "local", modelId: " " },
      { extra: true },
    ]) {
      expect(await invoke(request("webSearch.status", params))).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
  });

  it("tests the selected provider through the search owner with cache bypass and displays normalized sources", async () => {
    const respond = await invoke(request("webSearch.test", { query: " source query " }));
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "example",
        agentDir: "/synthetic/agent",
        preferInputConfig: true,
        args: { query: "source query", count: 5 },
        signal: expect.any(AbortSignal),
        config: { tools: { web: { search: { provider: "example", cacheTtlMinutes: 0 } } } },
      }),
    );
    expect(config.tools?.web?.search?.cacheTtlMinutes).toBe(15);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        provider: "example",
        status: "ok",
        latencyMs: expect.any(Number),
        cached: false,
        results: [{ title: "A source", url: "https://example.com/source", snippet: "A snippet" }],
      }),
      undefined,
    );
  });

  it("returns grounded answers with normalized citations", async () => {
    mocks.search.mockResolvedValue({
      provider: "example",
      result: {
        content: "A grounded answer",
        citations: [{ url: "https://example.com/source", title: "Source" }, "javascript:alert(1)"],
      },
    });
    expect(await invoke(request("webSearch.test", { query: "query" }))).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "ok",
        content: "A grounded answer",
        citations: [{ url: "https://example.com/source", title: "Source" }],
      }),
      undefined,
    );
  });

  it.each(["native", "external", "disabled", "unavailable"] as const)(
    "does not substitute a managed provider for a %s route",
    async (kind) => {
      searchStatus.route = {
        kind,
        label: "Other route",
        testable: false,
        reason: "Test this route in chat.",
      };
      expect(await invoke(request("webSearch.test", { query: "query" }))).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(mocks.search).not.toHaveBeenCalled();
    },
  );

  it("tests only the explicitly named configured managed service beside an external harness", async () => {
    searchStatus.route = { kind: "external", label: "Harness controls search", testable: false };
    searchStatus.testProvider = { id: "example", label: "Example Search" };
    expect(
      await invoke(request("webSearch.test", { query: "query", providerId: "other" })),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(mocks.search).not.toHaveBeenCalled();
    expect(
      await invoke(request("webSearch.test", { query: "query", providerId: "example" })),
    ).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ provider: "example", status: "ok" }),
      undefined,
    );
  });

  it("does not deliver status after read authority is revoked", async () => {
    const options = request("webSearch.status");
    mocks.prepare.mockImplementationOnce(async () => {
      options.client!.invalidated = true;
      return { status: searchStatus, config };
    });
    expect(await invoke(options)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  });

  it("does not start a provider test after the authenticated account changes", async () => {
    mocks.profile.mockReturnValue("original");
    mocks.prepare.mockImplementationOnce(async () => {
      mocks.profile.mockReturnValue("replacement");
      return { status: searchStatus, config, agentDir: "/synthetic/agent" };
    });
    expect(await invoke(request("webSearch.test", { query: "query" }))).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("requires current administrator authority before and after asynchronous preparation", async () => {
    const readOnly = request("webSearch.test", { query: "query" });
    readOnly.client!.connect.scopes = ["operator.read"];
    await invoke(readOnly);
    expect(mocks.prepare).not.toHaveBeenCalled();
    const revoked = request("webSearch.test", { query: "query" });
    mocks.prepare.mockImplementationOnce(async () => {
      revoked.client!.invalidated = true;
      return { status: searchStatus, config, agentDir: "/synthetic/agent" };
    });
    expect(await invoke(revoked)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("rejects configuration changes before invoking the provider and discards results after access is revoked", async () => {
    const original = config;
    mocks.prepare.mockImplementationOnce(async () => {
      config = { tools: { web: { search: { enabled: false } } } };
      return { status: searchStatus, config: original, agentDir: "/synthetic/agent" };
    });
    expect(await invoke(request("webSearch.test", { query: "query" }))).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    expect(mocks.search).not.toHaveBeenCalled();
    const revoked = request("webSearch.test", { query: "query" });
    mocks.search.mockImplementationOnce(async () => {
      revoked.client!.invalidated = true;
      return { provider: "example", result: { content: "Private result" } };
    });
    const respond = await invoke(revoked);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
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
      const respond = await invoke(request("webSearch.test", { query: "query" }));
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "error", error: expect.stringContaining(expected) }),
        undefined,
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
      const respond = await invoke(request("webSearch.test", { query: "query" }));
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "error" }),
        undefined,
      );
      expect(JSON.stringify(respond.mock.calls)).not.toContain("private-value");
    }
  });
});
