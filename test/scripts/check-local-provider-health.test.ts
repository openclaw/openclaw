import { describe, expect, it, vi } from "vitest";
import {
  buildLocalProviderHealthSummary,
  DEFAULT_VLLM_CODER_JOURNAL_UNITS,
  detectVllmCoderJournalIssue,
  listConfiguredLocalProviders,
  parseVllmCoderStartBlocked,
  probeLocalProvider,
  selectConfiguredLocalProvider,
} from "../../scripts/check-local-provider-health.mjs";

describe("scripts/check-local-provider-health", () => {
  it("lists configured local providers from models.json", () => {
    expect(
      listConfiguredLocalProviders({
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
          },
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [{ id: "qwen3.5:27b" }],
          },
          vllm: {
            baseUrl: "http://127.0.0.1:8000/v1",
            models: [{ id: "Qwen/Qwen3-30B-A3B" }],
          },
        },
      }),
    ).toEqual([
      {
        providerId: "ollama",
        api: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        modelIds: ["qwen3.5:27b"],
      },
      {
        providerId: "vllm",
        api: "vllm",
        baseUrl: "http://127.0.0.1:8000/v1",
        modelIds: ["Qwen/Qwen3-30B-A3B"],
      },
    ]);
  });

  it("selects the configured preferred provider when requested", () => {
    const payload = {
      providers: {
        ollama: { baseUrl: "http://127.0.0.1:11434", api: "ollama", models: [] },
        vllm: { baseUrl: "http://127.0.0.1:8000/v1", models: [] },
      },
    };

    expect(selectConfiguredLocalProvider(payload, "vllm")).toMatchObject({
      providerId: "vllm",
    });
    expect(selectConfiguredLocalProvider(payload)).toMatchObject({
      providerId: "ollama",
    });
  });

  it("probes Ollama tags using the configured base URL", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ models: [{ name: "qwen3.5:27b" }, { name: "gemma4:e4b" }] }),
    }));

    const result = await probeLocalProvider(
      {
        providerId: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "ollama",
        modelIds: ["qwen3.5:27b", "gemma4:e4b"],
      },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/tags",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toMatchObject({
      providerId: "ollama",
      ok: true,
      reachable: true,
      modelCount: 2,
      reason: "ok",
    });
  });

  it("parses vLLM coder blocked markers", () => {
    expect(
      parseVllmCoderStartBlocked(
        "VLLM_CODER_START_BLOCKED reason=VRAM_LOW free_mb=1466 min_free_mb=7000",
      ),
    ).toEqual({
      reason: "VRAM_LOW",
      freeMb: "1466",
      minFreeMb: "7000",
    });
  });

  it("prefers the tool-managed vLLM coder unit before the legacy unit", () => {
    const result = detectVllmCoderJournalIssue({
      units: [...DEFAULT_VLLM_CODER_JOURNAL_UNITS],
      journalByUnit: {
        "openclaw-tool-coder-vllm-models.service":
          "VLLM_CODER_START_BLOCKED reason=VRAM_LOW free_mb=1466 min_free_mb=7000",
        "openclaw-vllm-coder.service":
          "VLLM_CODER_START_BLOCKED reason=MODEL_LOAD_FAILED model=local-coder",
      },
    });

    expect(result).toEqual({
      reason: "VRAM_LOW",
      note: "journal_marker:openclaw-tool-coder-vllm-models.service",
      unit: "openclaw-tool-coder-vllm-models.service",
      freeMb: "1466",
      minFreeMb: "7000",
    });
  });

  it("uses vLLM journal fallback only when that provider is configured", () => {
    const summary = buildLocalProviderHealthSummary({
      provider: {
        providerId: "vllm",
        baseUrl: "http://127.0.0.1:8000/v1",
        api: "vllm",
        modelIds: ["Qwen/Qwen3-30B-A3B"],
      },
      probe: {
        ok: false,
        url: "http://127.0.0.1:8000/v1/models",
        modelCount: 0,
        reason: "connect ECONNREFUSED",
      },
      units: [...DEFAULT_VLLM_CODER_JOURNAL_UNITS],
      journalByUnit: {
        "openclaw-tool-coder-vllm-models.service":
          "VLLM_CODER_START_BLOCKED reason=VRAM_LOW free_mb=1466 min_free_mb=7000",
      },
    });

    expect(summary).toMatchObject({
      providerId: "vllm",
      configured: true,
      coderStatus: "DEGRADED",
      reason: "VRAM_LOW",
      note: "journal_marker:openclaw-tool-coder-vllm-models.service",
      unit: "openclaw-tool-coder-vllm-models.service",
    });
  });

  it("reports a plain HTTP probe failure for Ollama without vLLM-specific fallback", () => {
    const summary = buildLocalProviderHealthSummary({
      provider: {
        providerId: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        modelIds: ["qwen3.5:27b"],
      },
      probe: {
        ok: false,
        url: "http://127.0.0.1:11434/api/tags",
        modelCount: 0,
        reason: "connect ECONNREFUSED",
      },
    });

    expect(summary).toMatchObject({
      providerId: "ollama",
      configured: true,
      coderStatus: "DOWN",
      reason: "connect ECONNREFUSED",
      note: "http_probe_failed",
    });
  });
});
