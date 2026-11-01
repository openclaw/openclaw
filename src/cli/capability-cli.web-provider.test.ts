import { beforeEach, expect, it, vi } from "vitest";
import { runCapability } from "./capability-cli.test-harness.js";

const mocks = await vi.hoisted(async () => ({
  runtime: (await import("./test-runtime-mock.js")).createInertRuntime(vi),
  resolveLocalCapabilityRuntimeConfig: vi.fn(),
  runWebSearch: vi.fn(),
  resolveWebFetchDefinition: vi.fn(),
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));
vi.mock("./capability-cli/shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./capability-cli/shared.js")>()),
  resolveLocalCapabilityRuntimeConfig: mocks.resolveLocalCapabilityRuntimeConfig,
}));
vi.mock("../web-search/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../web-search/runtime.js")>()),
  runWebSearch: mocks.runWebSearch,
}));
vi.mock("../web-fetch/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../web-fetch/runtime.js")>()),
  resolveWebFetchDefinition: mocks.resolveWebFetchDefinition,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveLocalCapabilityRuntimeConfig.mockResolvedValue({});
  mocks.runWebSearch.mockResolvedValue({ provider: "brave", result: { results: [] } });
  mocks.resolveWebFetchDefinition.mockReturnValue({
    provider: { id: "firecrawl" },
    definition: { execute: vi.fn(async () => ({ content: "ok" })) },
  });
});

it("selects the web search provider case-insensitively", async () => {
  await runCapability("web", "search", "--query", "ping", "--provider", "Brave", "--json");

  expect(mocks.runWebSearch).toHaveBeenCalledWith(expect.objectContaining({ providerId: "brave" }));
});

it("selects the web fetch provider case-insensitively", async () => {
  await runCapability(
    "web",
    "fetch",
    "--url",
    "https://example.com",
    "--provider",
    "Firecrawl",
    "--json",
  );

  expect(mocks.resolveWebFetchDefinition).toHaveBeenCalledWith(
    expect.objectContaining({ providerId: "firecrawl" }),
  );
});
