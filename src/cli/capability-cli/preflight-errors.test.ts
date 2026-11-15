import "../../test-utils/prepare-compiled-subprocesses.js";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { defaultRuntime } from "../../runtime.js";
import { registerEmbeddingCapabilityCommands } from "./embedding.js";
import { registerWebCapabilityCommands } from "./web.js";

const mocks = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  createTool: vi.fn(),
  resolveFetch: vi.fn(),
  createEmbedding: vi.fn(),
}));
vi.mock("../../config/config.js", async (original) => ({
  ...(await original<typeof import("../../config/config.js")>()),
  captureRuntimeConfigAsyncReader: () => async () => mocks.config,
}));
vi.mock("../command-secret-targets.js", () => ({
  getCapabilityWebFetchCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
  getMemoryEmbeddingCommandSecretTargetIds: () => new Set<string>(),
}));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  resolveLocalCapabilityRuntimeConfig: async () => mocks.config,
  resolveLocalCapabilityAgent: async () => ({ cfg: mocks.config, agentDir: "/tmp/proof-agent" }),
}));
vi.mock("../../agents/tools/web-fetch.js", () => ({ createWebFetchTool: mocks.createTool }));
vi.mock("../../web-fetch/runtime.js", () => ({ resolveWebFetchDefinition: mocks.resolveFetch }));
vi.mock("../../plugin-sdk/memory-core-bundled-runtime.js", () => ({
  createEmbeddingProvider: mocks.createEmbedding,
}));

let savedArgv: string[];
beforeEach(() => {
  savedArgv = process.argv;
  // Exercise the actual wrapper's JSON error propagation, rather than its text exit.
  process.argv = ["node", "openclaw", "infer", "--json"];
  mocks.config = { tools: { web: { fetch: { enabled: false } } } };
  mocks.createTool.mockReset().mockReturnValue(null);
  mocks.resolveFetch.mockReset().mockReturnValue(null);
  mocks.createEmbedding.mockReset();
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
});
afterEach(() => {
  process.argv = savedArgv;
  vi.restoreAllMocks();
});

async function run(domain: "web" | "embedding", ...args: string[]) {
  const command = new Command();
  if (domain === "web") {
    registerWebCapabilityCommands(command);
  } else {
    registerEmbeddingCapabilityCommands(command);
  }
  await command.parseAsync([domain, ...args, "--json"], { from: "user" });
}

it.each([
  { enabled: false, provider: undefined },
  { enabled: false, provider: "fixture" },
  { enabled: true, provider: "fixture" },
])("classifies fetch availability with enabled=$enabled and provider=$provider", async (opts) => {
  mocks.config = { tools: { web: { fetch: { enabled: opts.enabled } } } };
  const reason = opts.enabled
    ? 'web.fetch provider "fixture" is not available; check it with `openclaw infer web providers`.'
    : "web.fetch is disabled. Set tools.web.fetch.enabled=true to enable it.";
  await expect(
    run(
      "web",
      "fetch",
      "--url",
      "https://example.invalid",
      ...(opts.provider ? ["--provider", opts.provider] : []),
    ),
  ).rejects.toMatchObject({ name: "ExpectedCliError", humanOutput: reason, machineOutput: reason });
  expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
});

it("classifies conflicting embedding flags before creating a provider", async () => {
  await expect(
    run(
      "embedding",
      "create",
      "--text",
      "hello",
      "--provider",
      "deepinfra",
      "--model",
      "Qwen/model",
    ),
  ).rejects.toMatchObject({
    name: "ExpectedCliError",
    humanOutput: expect.stringContaining(
      'Embedding --provider "deepinfra" must match the provider "Qwen"',
    ),
  });
  expect(mocks.createEmbedding).not.toHaveBeenCalled();
});

it("preserves unexpected fetch errors", async () => {
  const error = new Error("provider execution failed");
  mocks.createTool.mockReturnValue({ execute: vi.fn().mockRejectedValue(error) });
  await expect(run("web", "fetch", "--url", "https://example.invalid")).rejects.toBe(error);
});

it.each([false, true])(
  "keeps matching embedding flags on the provider path, failed=$failed",
  async (failed) => {
    const error = new Error("embedding request failed");
    const close = vi.fn();
    mocks.createEmbedding.mockResolvedValue({
      provider: {
        id: "fixture",
        model: "model",
        close,
        embedBatch: failed ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue([[1, 2]]),
      },
    });
    const result = run(
      "embedding",
      "create",
      "--text",
      "hello",
      "--provider",
      "fixture",
      "--model",
      "fixture/model",
    );
    if (failed) {
      await expect(result).rejects.toBe(error);
    } else {
      await result;
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: true,
          provider: "fixture",
          outputs: [{ text: "hello", embedding: [1, 2], dimensions: 2 }],
        }),
        2,
      );
    }
    expect(close).toHaveBeenCalledOnce();
  },
);
