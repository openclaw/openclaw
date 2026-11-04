import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelScanResult } from "../../agents/model-scan.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createCapturingTestRuntime } from "../test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  loadModelsConfig: vi.fn(),
  resolveApiKeyForProviderCore: vi.fn(),
  scanOpenRouterModels: vi.fn(),
  updateConfig: vi.fn(),
}));

// mock-isolation: Scan tests use synthetic catalog, credentials, and results without provider discovery or config reads.
vi.mock("./load-config.js", () => ({ loadModelsConfig: mocks.loadModelsConfig }));

vi.mock("../../agents/model-auth.js", () => ({
  resolveApiKeyForProviderCore: mocks.resolveApiKeyForProviderCore,
}));

// mock-isolation: Scan tests use synthetic catalog, credentials, and results without provider discovery or config reads.
vi.mock("../../agents/model-scan.js", () => ({ scanOpenRouterModels: mocks.scanOpenRouterModels }));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  updateConfig: mocks.updateConfig,
}));

const { modelsScanCommand } = await import("./scan.js");
const modelRef = (name = "acme") => `openrouter/${name}/free:free`;
const metadataError = "Cannot apply metadata-only OpenRouter scan results";

function scanResult(overrides: Partial<ModelScanResult> = {}) {
  return {
    modelRef: modelRef(),
    contextLength: 128_000,
    modality: "text",
    inferredParamB: 70,
    tool: { ok: false, latencyMs: null, skipped: true },
    image: { ok: false, latencyMs: null, skipped: true },
    ...overrides,
  };
}

describe("models scan command", () => {
  let capture: ReturnType<typeof createCapturingTestRuntime>;
  const output = () => capture.logs;
  const scan = (opts: Parameters<typeof modelsScanCommand>[0]) =>
    modelsScanCommand(opts, capture.runtime);
  function expectNoAuthLookup() {
    expect(mocks.loadModelsConfig).not.toHaveBeenCalled();
    expect(mocks.resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  }
  function withoutStoredKey() {
    mocks.loadModelsConfig.mockResolvedValue({});
    mocks.resolveApiKeyForProviderCore.mockResolvedValue({ apiKey: "" });
  }
  beforeEach(() => {
    vi.clearAllMocks();
    capture = createCapturingTestRuntime();
    capture.runtime.exit = (code) => {
      throw new Error(`exit ${code ?? 0}`);
    };
    mocks.scanOpenRouterModels.mockResolvedValue([scanResult()]);
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("prints metadata-only JSON in the same deterministic ranking as the table", async () => {
    mocks.scanOpenRouterModels.mockResolvedValue(
      ["zeta", "alpha", "larger"].map((name) =>
        scanResult({
          modelRef: modelRef(name),
          contextLength: name === "larger" ? 256_000 : 128_000,
        }),
      ),
    );

    await scan({ probe: false, json: true });

    expect(output()).toHaveLength(1);
    const results = JSON.parse(output()[0] ?? "") as ModelScanResult[];
    expect(results.map((result) => result.modelRef)).toEqual(
      ["larger", "alpha", "zeta"].map(modelRef),
    );
    expectNoAuthLookup();
  });

  it("sanitizes provider-controlled model refs and modality in scan tables", async () => {
    mocks.scanOpenRouterModels.mockResolvedValue([
      scanResult({
        modelRef: "openrouter/evil\u001b[31m\nmodel:free",
        modality: "text\u001b[31m\nnext\tvalue\u0007",
      }),
    ]);

    await scan({ probe: false });

    const row = output().find((line) => line.includes("openrouter/evil"));
    expect(row).toContain("openrouter/evil\\nmodel:free");
    expect(row).toContain("modality:text\\nnext\\tvalue");
    expect(row).not.toMatch(/\p{Cc}/u);
  });

  it("downgrades to metadata-only scan when no OpenRouter key is configured", async () => {
    withoutStoredKey();
    await scan({});
    expect(mocks.resolveApiKeyForProviderCore).toHaveBeenCalledWith({
      provider: "openrouter",
      cfg: {},
    });
    expect(mocks.scanOpenRouterModels.mock.calls[0]?.[0].probe).toBe(false);
    expect(output().join("\n")).toContain("still require OPENROUTER_API_KEY");
  });

  it("uses OPENROUTER_API_KEY directly without loading model config", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    mocks.scanOpenRouterModels.mockResolvedValue([
      scanResult({ tool: { ok: false, latencyMs: null, skipped: false } }),
    ]);

    await expect(scan({ json: true })).rejects.toThrow(
      /No tool-capable OpenRouter free models found/,
    );

    expectNoAuthLookup();
    expect(mocks.scanOpenRouterModels.mock.calls[0]?.[0]).toMatchObject({
      apiKey: "sk-or-test",
      probe: true,
    });
  });

  it.each([
    [{ probe: false, setDefault: true }, metadataError, false],
    [{ setDefault: true }, metadataError, true],
    [{ maxAgeDays: "30d", probe: false, setDefault: true }, "--max-age-days", false],
    [{ timeout: "1000ms", probe: false, setDefault: true }, "--timeout", false],
    [{ concurrency: "2x", probe: false, setDefault: true }, "--concurrency", false],
  ] as const)(
    "rejects invalid scan options %j before scanning",
    async (opts, message, resolveAuth) => {
      if (resolveAuth) {
        withoutStoredKey();
      }
      await expect(scan(opts)).rejects.toThrow(message);
      if (!resolveAuth) {
        expectNoAuthLookup();
      }
      expect(mocks.scanOpenRouterModels).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{}, "anthropic/primary"],
    [{ setDefault: true }, modelRef()],
  ])("updates fallbacks (options: %j)", async (opts, primary) => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    mocks.scanOpenRouterModels.mockResolvedValue([
      scanResult({ tool: { ok: true, latencyMs: 5, skipped: false } }),
    ]);
    const before: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "anthropic/primary", fallbacks: ["anthropic/backup"] } },
      },
    };
    let after: OpenClawConfig | undefined;
    mocks.updateConfig.mockImplementation(
      async (mutate: (cfg: OpenClawConfig) => OpenClawConfig) => (after = mutate(before)),
    );

    await scan({ ...opts, yes: true, json: true });

    expect(after?.agents?.defaults?.model).toEqual({
      primary,
      fallbacks: [modelRef()],
    });
    expect(after?.agents?.defaults?.models).toHaveProperty([modelRef()]);
  });

  it("summarizes mixed tool and image capability results", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const capabilities: Array<[string, boolean, boolean]> = [
      ["both-a", true, true],
      ["both-b", true, true],
      ["tools", true, false],
      ["images", false, true],
      ["neither", false, false],
    ];
    mocks.scanOpenRouterModels.mockResolvedValue(
      capabilities.map(([name, tool, image]) =>
        scanResult({
          modelRef: modelRef(name),
          tool: { ok: tool, latencyMs: 5, skipped: false },
          image: { ok: image, latencyMs: 5, skipped: false },
        }),
      ),
    );
    mocks.updateConfig.mockImplementation(async (mutate: (cfg: OpenClawConfig) => OpenClawConfig) =>
      mutate({}),
    );

    await scan({ yes: true });

    expect(output()).toContain(
      "Scan results: tested 5, tool ok 3, image ok 3, tool+image ok 2, image only 1",
    );
  });
});
