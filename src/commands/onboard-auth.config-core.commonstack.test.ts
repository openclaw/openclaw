import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";

const mocks = vi.hoisted(() => ({
  scanCommonstackModels: vi.fn(),
  select: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  spinnerStart: vi.fn(),
  spinnerStop: vi.fn(),
}));

vi.mock("../agents/model-scan.js", () => ({
  scanCommonstackModels: mocks.scanCommonstackModels,
}));

vi.mock("@clack/prompts", () => ({
  select: mocks.select,
  cancel: mocks.cancel,
  isCancel: mocks.isCancel,
  spinner: () => ({
    start: mocks.spinnerStart,
    stop: mocks.spinnerStop,
  }),
}));

import { applyCommonstackConfig } from "./onboard-auth.config-core.js";

const COMMONSTACK_MODEL_REF = "commonstack/openai/gpt-5.4-pro-2026-03-05";
const COMMONSTACK_MODEL_ID = "openai/gpt-5.4-pro-2026-03-05";

describe("applyCommonstackConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isCancel.mockReturnValue(false);
    mocks.select.mockResolvedValue(COMMONSTACK_MODEL_REF);
    mocks.scanCommonstackModels.mockResolvedValue([
      {
        id: COMMONSTACK_MODEL_ID,
        name: COMMONSTACK_MODEL_ID,
        provider: "commonstack",
        modelRef: COMMONSTACK_MODEL_REF,
        contextLength: null,
        maxCompletionTokens: null,
        supportedParametersCount: 0,
        supportsToolsMeta: false,
        modality: "text",
        inferredParamB: null,
        createdAtMs: null,
        pricing: null,
        isFree: false,
        tool: { ok: false, latencyMs: null, skipped: true },
        image: { ok: false, latencyMs: null, skipped: true },
      },
    ]);
  });

  it("syncs selected model to defaults + allowlist + provider catalog", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { fallbacks: ["anthropic/claude-opus-4-6"] },
        },
      },
    };

    const result = await applyCommonstackConfig(cfg, {
      apiKey: "test-commonstack-key", // pragma: allowlist secret
      setDefaultModel: true,
      nonInteractive: false,
    });

    expect(mocks.scanCommonstackModels).toHaveBeenCalledWith({
      apiKey: "test-commonstack-key", // pragma: allowlist secret
      probe: false,
    });
    expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
      COMMONSTACK_MODEL_REF,
    );
    expect(result.config.agents?.defaults?.models?.[COMMONSTACK_MODEL_REF]).toEqual({});
    expect(result.config.models?.providers?.commonstack?.baseUrl).toBe(
      "https://api.commonstack.ai/v1",
    );
    expect(result.config.models?.providers?.commonstack?.api).toBe("openai-completions");
    expect(
      result.config.models?.providers?.commonstack?.models?.some(
        (model) => model.id === COMMONSTACK_MODEL_ID,
      ),
    ).toBe(true);
  });
});
