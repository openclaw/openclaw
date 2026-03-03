import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildVeniceModelDefinition,
  discoverVeniceModels,
  VENICE_MODEL_CATALOG,
} from "./venice-models.js";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_VITEST = process.env.VITEST;

function restoreDiscoveryEnv(): void {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }

  if (ORIGINAL_VITEST === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = ORIGINAL_VITEST;
  }
}

async function runWithDiscoveryEnabled<T>(operation: () => Promise<T>): Promise<T> {
  process.env.NODE_ENV = "development";
  delete process.env.VITEST;
  try {
    return await operation();
  } finally {
    restoreDiscoveryEnv();
  }
}

function makeModelsResponse(id: string): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          id,
          model_spec: {
            name: id,
            privacy: "private",
            availableContextTokens: 131072,
            capabilities: {
              supportsReasoning: false,
              supportsVision: false,
              supportsFunctionCalling: true,
            },
          },
        },
      ],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

describe("venice-models", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreDiscoveryEnv();
  });

  it("buildVeniceModelDefinition returns config with required fields", () => {
    const entry = VENICE_MODEL_CATALOG[0];
    const def = buildVeniceModelDefinition(entry);
    expect(def.id).toBe(entry.id);
    expect(def.name).toBe(entry.name);
    expect(def.reasoning).toBe(entry.reasoning);
    expect(def.input).toEqual(entry.input);
    expect(def.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(def.contextWindow).toBe(entry.contextWindow);
    expect(def.maxTokens).toBe(entry.maxTokens);
  });

  it("retries transient fetch failures before succeeding", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNRESET", message: "socket hang up" },
        });
      }
      return makeModelsResponse("llama-3.3-70b");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels());
    expect(attempts).toBe(3);
    expect(models.map((m) => m.id)).toContain("llama-3.3-70b");
  });

  it("falls back to static catalog after retry budget is exhausted", async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api.venice.ai" },
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await runWithDiscoveryEnabled(() => discoverVeniceModels());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(models).toHaveLength(VENICE_MODEL_CATALOG.length);
    expect(models.map((m) => m.id)).toEqual(VENICE_MODEL_CATALOG.map((m) => m.id));
  });
});
