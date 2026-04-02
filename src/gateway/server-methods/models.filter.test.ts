/**
 * Tests for the models.list handler's filter parameter wiring and _meta
 * response shape.  These verify that the handler correctly:
 *   1. Reads the filter param from the request.
 *   2. Falls back to config when no request-level param is given.
 *   3. Defaults to "all" when neither request param nor config is set.
 *   4. Returns _meta with totalCount, filteredCount, filterMode.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";

// Use vi.hoisted so shared state is available when mock factories execute.
const { getMockConfig, setMockConfig } = vi.hoisted(() => {
  let _mockConfig: unknown = {};
  return {
    getMockConfig: () => _mockConfig,
    setMockConfig: (cfg: unknown) => {
      _mockConfig = cfg;
    },
  };
});

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadConfig: () => getMockConfig(),
  };
});

import { modelsHandlers } from "./models.js";
import type { RespondFn } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CATALOG: ModelCatalogEntry[] = [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
];

function makeContext() {
  return {
    loadGatewayModelCatalog: async () => CATALOG,
  } as unknown as Parameters<(typeof modelsHandlers)["models.list"]>[0]["context"];
}

type CapturedResponse = {
  ok: boolean;
  payload: unknown;
  error: unknown;
};

async function callModelsListHandler(
  params: Record<string, unknown>,
  config?: OpenClawConfig,
): Promise<CapturedResponse> {
  setMockConfig(config ?? {});

  let captured: CapturedResponse | null = null;
  const respond: RespondFn = (ok, payload, error) => {
    captured = { ok, payload, error };
  };

  await modelsHandlers["models.list"]({
    req: { method: "models.list", id: "1", params: {} } as never,
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: makeContext(),
  });

  if (!captured) {
    throw new Error("Handler did not call respond");
  }
  return captured;
}

type ModelsListResult = {
  models: ModelCatalogEntry[];
  _meta: {
    totalCount: number;
    filteredCount: number;
    filterMode: string;
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('models.list handler filter wiring and "_meta" shape', () => {
  beforeEach(() => {
    // Clear provider API key env vars to control auth deterministically.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('defaults to "all" when neither request param nor config is set', async () => {
    const result = await callModelsListHandler({});
    expect(result.ok).toBe(true);
    const data = result.payload as ModelsListResult;
    expect(data._meta.filterMode).toBe("all");
    expect(data._meta.totalCount).toBe(CATALOG.length);
    expect(data._meta.filteredCount).toBe(CATALOG.length);
    expect(data.models).toHaveLength(CATALOG.length);
  });

  test("respects explicit filter param from request", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

    const result = await callModelsListHandler({ filter: "authenticated" });
    expect(result.ok).toBe(true);
    const data = result.payload as ModelsListResult;
    expect(data._meta.filterMode).toBe("authenticated");
    // Only anthropic models should pass through.
    expect(data._meta.filteredCount).toBe(2);
    expect(data.models.every((m) => m.provider === "anthropic")).toBe(true);
  });

  test("falls back to config filter when no request param is given", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-test");

    const config = {
      gateway: {
        controlUi: {
          modelSelector: { filter: "authenticated" },
        },
      },
    } as OpenClawConfig;

    const result = await callModelsListHandler({}, config);
    expect(result.ok).toBe(true);
    const data = result.payload as ModelsListResult;
    expect(data._meta.filterMode).toBe("authenticated");
    // Only openai models should pass through.
    expect(data._meta.filteredCount).toBe(1);
    expect(data.models[0]?.provider).toBe("openai");
  });

  test("request param overrides config filter", async () => {
    const config = {
      gateway: {
        controlUi: {
          modelSelector: { filter: "authenticated" },
        },
      },
    } as OpenClawConfig;

    // Request says "all" even though config says "authenticated"
    const result = await callModelsListHandler({ filter: "all" }, config);
    expect(result.ok).toBe(true);
    const data = result.payload as ModelsListResult;
    expect(data._meta.filterMode).toBe("all");
    expect(data._meta.filteredCount).toBe(CATALOG.length);
  });

  test("_meta.totalCount reflects the base catalog size (before filtering)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

    const result = await callModelsListHandler({ filter: "authenticated" });
    expect(result.ok).toBe(true);
    const data = result.payload as ModelsListResult;
    expect(data._meta.totalCount).toBe(CATALOG.length);
    expect(data._meta.filteredCount).toBeLessThanOrEqual(data._meta.totalCount);
  });

  test('"configured" filter with models configured', async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.2" },
          models: {
            "openai/gpt-5.2": {},
          },
        },
      },
    } as OpenClawConfig;

    const result = await callModelsListHandler({ filter: "configured" }, config);
    expect(result.ok).toBe(true);
    const data = result.payload as ModelsListResult;
    expect(data._meta.filterMode).toBe("configured");
    // Only the configured model should appear.
    expect(data.models.some((m) => m.id === "gpt-5.2")).toBe(true);
  });
});
