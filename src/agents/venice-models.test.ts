import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildVeniceModelDefinition,
  discoverVeniceModels,
  VENICE_MODEL_CATALOG,
} from "./venice-models.js";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_VITEST = process.env.VITEST;
const ORIGINAL_FETCH = globalThis.fetch;

function setNonTestEnv() {
  process.env.NODE_ENV = "development";
  delete process.env.VITEST;
}

describe("venice-models", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_VITEST === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = ORIGINAL_VITEST;
    }
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("buildVeniceModelDefinition preserves catalog maxTokens", () => {
    const entry = VENICE_MODEL_CATALOG.find((m) => m.id === "llama-3.3-70b");
    expect(entry).toBeDefined();
    const def = buildVeniceModelDefinition(entry!);
    expect(def.maxTokens).toBe(4096);
  });

  it("uses Venice API maxCompletionTokens for known catalog models", async () => {
    setNonTestEnv();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "llama-3.3-70b",
            model_spec: {
              name: "Llama 3.3 70B",
              privacy: "private",
              availableContextTokens: 128000,
              maxCompletionTokens: 4096,
              capabilities: {
                supportsReasoning: false,
                supportsVision: false,
                supportsFunctionCalling: true,
              },
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const models = await discoverVeniceModels();
    const llama = models.find((m) => m.id === "llama-3.3-70b");

    expect(llama).toBeDefined();
    expect(llama?.maxTokens).toBe(4096);
    expect(llama?.contextWindow).toBe(128000);
  });

  it("falls back to 8192 for unknown models without maxCompletionTokens", async () => {
    setNonTestEnv();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "new-unknown-model",
            model_spec: {
              name: "New Unknown",
              privacy: "private",
              availableContextTokens: 64000,
              capabilities: {
                supportsReasoning: false,
                supportsVision: false,
                supportsFunctionCalling: false,
              },
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const models = await discoverVeniceModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.maxTokens).toBe(8192);
    expect(models[0]?.contextWindow).toBe(64000);
  });
});
