import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelScanResult } from "../../agents/model-scan.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { withEnvAsync } from "../../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  loadModelsConfig: vi.fn(),
  resolveApiKeyForProviderCore: vi.fn(),
  scanOpenRouterModels: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("../../agents/model-auth.js", () => ({
  resolveApiKeyForProviderCore: mocks.resolveApiKeyForProviderCore,
}));

vi.mock("../../agents/model-scan.js", () => ({
  scanOpenRouterModels: mocks.scanOpenRouterModels,
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  updateConfig: mocks.updateConfig,
}));

const { modelsScanCommand } = await import("./scan.js");

function createRuntime(): RuntimeEnv & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (...args: unknown[]) => lines.push(args.join(" ")),
    error: (...args: unknown[]) => lines.push(args.join(" ")),
    exit: (code?: number) => {
      throw new Error(`exit ${code ?? 0}`);
    },
  };
}

function scanResult(overrides: Partial<ModelScanResult> = {}): ModelScanResult {
  return {
    id: "acme/free:free",
    name: "ACME Free",
    provider: "openrouter",
    modelRef: "openrouter/acme/free:free",
    contextLength: 128_000,
    maxCompletionTokens: 8192,
    supportedParametersCount: 2,
    supportsToolsMeta: true,
    modality: "text",
    inferredParamB: 70,
    createdAtMs: 1_700_000_000_000,
    pricing: { prompt: 0, completion: 0, request: 0, image: 0, webSearch: 0, internalReasoning: 0 },
    isFree: true,
    tool: { ok: false, latencyMs: null, skipped: true },
    image: { ok: false, latencyMs: null, skipped: true },
    ...overrides,
  };
}

function withOpenRouterApiKey<T>(apiKey: string | undefined, fn: () => Promise<T>): Promise<T> {
  return withEnvAsync({ OPENROUTER_API_KEY: apiKey }, fn);
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
  });

  it("prints metadata-only JSON in the same deterministic ranking as the table", async () => {
    mocks.scanOpenRouterModels.mockResolvedValue(
      ["zeta", "alpha", "larger"].map((name) =>
        scanResult({
          id: `${name}/free:free`,
          modelRef: `openrouter/${name}/free:free`,
          contextLength: name === "larger" ? 256_000 : 128_000,
        }),
      ),
    );

    await scan({ probe: false, json: true });

    expect(runtime.lines).toHaveLength(1);
    const results = JSON.parse(runtime.lines[0] ?? "") as ModelScanResult[];
    expect(results.map((result) => result.modelRef)).toEqual([
      "openrouter/larger/free:free",
      "openrouter/alpha/free:free",
      "openrouter/zeta/free:free",
    ]);
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
    expect(
      Array.from(row ?? "").every((character) => {
        const code = character.charCodeAt(0);
        return code > 0x1f && (code < 0x7f || code > 0x9f);
      }),
    ).toBe(true);
  });

  it("downgrades to metadata-only scan when no OpenRouter key is configured", async () => {
    await withOpenRouterApiKey(undefined, async () => {
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
  });

  it("uses OPENROUTER_API_KEY directly without loading model config", async () => {
    await withOpenRouterApiKey("sk-or-test", async () => {
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
  });

  it("rejects applying metadata-only scan results", async () => {
    await withOpenRouterApiKey(undefined, async () => {
      await expect(scan({ probe: false, setDefault: true })).rejects.toThrow(
        /Cannot apply metadata-only OpenRouter scan results/,
      );

      expect(mocks.scanOpenRouterModels).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ["maxAgeDays", "--max-age-days", "30d"],
    ["timeout", "--timeout", "1000ms"],
    ["concurrency", "--concurrency", "2x"],
  ] as const)("%s numeric value", (key, label, raw) => {
    it("rejects partial numeric strings before scanning", async () => {
      await expect(scan({ [key]: raw, probe: false, setDefault: true })).rejects.toThrow(label);

      expectNoAuthLookup();
      expect(mocks.scanOpenRouterModels).not.toHaveBeenCalled();
    });
  });

  it("rejects applying auto-downgraded metadata-only scan results before scanning", async () => {
    await withOpenRouterApiKey(undefined, async () => {
      withoutStoredKey();

      await expect(scan({ setDefault: true })).rejects.toThrow(
        /Cannot apply metadata-only OpenRouter scan results/,
      );

      expect(mocks.scanOpenRouterModels).not.toHaveBeenCalled();
    });
  });

  it.each([
    [{}, "anthropic/primary"],
    [{ setDefault: true }, "openrouter/acme/free:free"],
  ])(
    "replaces fallbacks and sets the primary only with --set-default (%j)",
    async (opts, primary) => {
      await withOpenRouterApiKey("sk-or-test", async () => {
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
          fallbacks: ["openrouter/acme/free:free"],
        });
        expect(after?.agents?.defaults?.models).toHaveProperty(["openrouter/acme/free:free"]);
      });
    },
  );
});
