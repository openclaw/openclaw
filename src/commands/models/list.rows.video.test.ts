// Native-video model listing coverage stays separate from the large general row suite.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelRow } from "./list.types.js";

const mocks = vi.hoisted(() => ({
  normalizeProviderResolvedModelWithPlugin: vi.fn(() => undefined),
  resolveBundledProviderPolicySurface: vi.fn(() => null),
  shouldSuppressBuiltInModelFromManifest: vi.fn(() => false),
}));

vi.mock("../../agents/model-suppression.js", () => ({
  shouldSuppressBuiltInModel: vi.fn(() => false),
  shouldSuppressBuiltInModelFromManifest: mocks.shouldSuppressBuiltInModelFromManifest,
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  normalizeProviderResolvedModelWithPlugin: mocks.normalizeProviderResolvedModelWithPlugin,
}));

vi.mock("../../plugins/provider-public-artifacts.js", () => ({
  resolveBundledProviderPolicySurface: mocks.resolveBundledProviderPolicySurface,
}));

import {
  appendConfiguredProviderRows,
  appendPreparedModelCatalogRows,
  type RowBuilderContext,
} from "./list.rows.js";

function rowContext(cfg: OpenClawConfig = {}): RowBuilderContext {
  return {
    cfg,
    agentDir: "/tmp/openclaw-agent",
    authIndex: {
      evaluateModelAuth: () => ({ availability: true, routeResolution: null }),
    },
    configuredByKey: new Map(),
    discoveredKeys: new Set(["moonshot/kimi-k3"]),
    filter: { provider: "moonshot" },
    skipRuntimeModelSuppression: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("native video model listing", () => {
  it("preserves declared video and document inputs through catalog route projection", async () => {
    const rows: ModelRow[] = [];
    const entry: ModelCatalogEntry = {
      id: "kimi-k3",
      name: "Kimi K3",
      provider: "moonshot",
      api: "openai-completions",
      input: ["text", "image", "video", "audio", "document"],
      contextWindow: 262_144,
    };

    await appendPreparedModelCatalogRows({
      rows,
      seenKeys: new Set(),
      catalogSnapshot: { entries: [entry], routeVariants: [entry] },
      context: rowContext(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.input).toBe("text+image+video+document");
  });

  it("preserves configured native video through provider runtime normalization", async () => {
    mocks.normalizeProviderResolvedModelWithPlugin.mockReturnValueOnce({
      provider: "moonshot",
      id: "kimi-k3",
      name: "Kimi K3",
      input: ["text", "image", "video"],
      contextWindow: 262_144,
    } as never);
    const rows: ModelRow[] = [];

    await appendConfiguredProviderRows({
      rows,
      seenKeys: new Set(),
      context: rowContext({
        models: {
          providers: {
            moonshot: {
              api: "openai-completions",
              baseUrl: "https://api.moonshot.ai/v1",
              models: [
                {
                  id: "kimi-k3",
                  name: "Kimi K3",
                  reasoning: true,
                  input: ["text", "image", "video"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 262_144,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
      }),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.input).toBe("text+image+video");
    expect(mocks.normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledOnce();
  });
});
