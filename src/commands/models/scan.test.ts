import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelScanResult } from "../../agents/model-scan.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";

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

function createRuntime(): RuntimeEnv & { lines: string[] } {
  const lines: string[] = [];
  const log = (...args: unknown[]) => lines.push(args.join(" "));
  const exit = (code?: number): never => {
    throw new Error(`exit ${code ?? 0}`);
  };
  return { lines, log, error: log, exit };
}

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
  let runtime: ReturnType<typeof createRuntime>;
  const scan = (opts: Parameters<typeof modelsScanCommand>[0]) => modelsScanCommand(opts, runtime);
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
    runtime = createRuntime();
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

    expect(runtime.lines).toHaveLength(1);
    const results = JSON.parse(runtime.lines[0] ?? "") as ModelScanResult[];
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

    const row = runtime.lines.find((line) => line.includes("openrouter/evil"));
    expect(row).toContain("openrouter/evil\\nmodel:free");
    expect(row).toContain("modality:text\\nnext\\tvalue");
    expect(row).not.toMatch(/\p{Cc}/u);
  });

  it("downgrades to metadata-only scan when no OpenRouter key is configured", async () => {
    withoutStoredKey();
    mocks.scanOpenRouterModels.mockResolvedValue([scanResult()]);

    await scan({});

    expect(mocks.loadModelsConfig).toHaveBeenCalledTimes(1);
    expect(mocks.resolveApiKeyForProviderCore).toHaveBeenCalledWith({
      provider: "openrouter",
      cfg: {},
    });
    expect(mocks.scanOpenRouterModels).toHaveBeenCalledTimes(1);
    expect(mocks.scanOpenRouterModels.mock.calls[0]?.[0].probe).toBe(false);
    expect(runtime.lines.join("\n")).toContain("still require OPENROUTER_API_KEY");
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
    expect(mocks.scanOpenRouterModels).toHaveBeenCalledTimes(1);
    expect(mocks.scanOpenRouterModels.mock.calls[0]?.[0]).toMatchObject({
      apiKey: "sk-or-test",
      probe: true,
    });
  });

  it.each([false, true])(
    "rejects applying metadata-only results (auto-downgraded=%s)",
    async (auto) => {
      if (auto) {
        withoutStoredKey();
      }
      await expect(scan({ probe: auto ? undefined : false, setDefault: true })).rejects.toThrow(
        /Cannot apply metadata-only OpenRouter scan results/,
      );

      expect(mocks.scanOpenRouterModels).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["maxAgeDays", "--max-age-days", "30d"],
    ["timeout", "--timeout", "1000ms"],
    ["concurrency", "--concurrency", "2x"],
  ] as const)("rejects partial %s numeric strings before scanning", async (key, label, raw) => {
    await expect(scan({ [key]: raw, probe: false, setDefault: true })).rejects.toThrow(label);

    expectNoAuthLookup();
    expect(mocks.scanOpenRouterModels).not.toHaveBeenCalled();
  });

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
});
