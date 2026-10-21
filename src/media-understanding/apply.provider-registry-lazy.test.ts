import { beforeEach, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";

type TestCatalogEntry = { id: string; name: string; provider: string; input: readonly string[] };

const model = { id: "gpt-5.4", name: "GPT-5.4", provider: "usage-proxy" };
let catalog: TestCatalogEntry[] = [{ ...model, input: ["text", "image"] }];

const resolvePluginCapabilityProvidersSpy = vi.hoisted(() => vi.fn());

vi.mock("../agents/image-compression-policy.js", () => ({
  resolveImageCompressionModelPolicy: vi.fn(async () => ({})),
}));

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: (params: { key: string }) => {
    if (params.key === "mediaUnderstandingProviders") {
      resolvePluginCapabilityProvidersSpy(params);
    }
    return [];
  },
}));

// mock-isolation: Supply the selected-model catalog without invoking provider discovery.
vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: vi.fn(async (_params: unknown) => catalog),
}));

const { applyMediaUnderstanding } = await import("./apply.js");
const activeModel = { provider: "usage-proxy", model: "gpt-5.4" };
const visionModel = {
  id: model.id,
  name: model.name,
  input: ["text", "image"] satisfies ("text" | "image")[],
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 128,
};
const visionConfig: OpenClawConfig = {
  models: {
    providers: { "usage-proxy": { baseUrl: "https://example.test/v1", models: [visionModel] } },
  },
};

function configWithModels(capabilities?: ("image" | "audio" | "video")[]): OpenClawConfig {
  const cfg = { ...visionConfig };
  if (capabilities) {
    cfg.tools = { media: { models: [{ provider: model.provider, capabilities }] } };
  }
  return cfg;
}

function breakRegistry() {
  resolvePluginCapabilityProvidersSpy.mockImplementation(() => {
    throw new Error("registry build failed");
  });
}

function imageContext(withAudio = false): MsgContext {
  return {
    media: [
      { path: "/tmp/image.png", contentType: "image/png" },
      ...(withAudio ? [{ path: "/tmp/note.ogg", contentType: "audio/ogg" }] : []),
    ],
  };
}

const apply = (ctx: MsgContext, cfg: OpenClawConfig) =>
  applyMediaUnderstanding({ ctx, cfg, activeModel });

beforeEach(() => {
  catalog = [{ ...model, input: ["text", "image"] }];
  resolvePluginCapabilityProvidersSpy.mockReset();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

it.each([
  ["explicit image model", configWithModels(["image"]), false, ["text", "image"]],
  ["text-only model", {}, false, ["text"]],
  ["mixed image and audio", visionConfig, true, ["text", "image"]],
] as const)("builds the registry once for %s", async (_name, cfg, audio, input) => {
  catalog = [{ ...model, input }];
  await apply(imageContext(audio), cfg);
  expect(resolvePluginCapabilityProvidersSpy).toHaveBeenCalledTimes(1);
});

it("a registry build failure still rejects the whole apply (caller's raw-content fallback), built once", async () => {
  breakRegistry();
  catalog = [{ ...model, input: ["text"] }];
  const ctx = imageContext(true);

  await expect(apply(ctx, {})).rejects.toThrow("registry build failed");
  expect(resolvePluginCapabilityProvidersSpy).toHaveBeenCalledTimes(1);
  expect(ctx.MediaUnderstandingDecisions).toBeUndefined();
});

it.each([
  { name: "no shared models", capabilities: undefined },
  { name: "audio and video shared models", capabilities: ["audio", "video"] },
] as const)("keeps native vision with $name", async ({ capabilities }) => {
  breakRegistry();
  const cfg = configWithModels(capabilities ? [...capabilities] : undefined);
  const ctx = imageContext();
  await expect(apply(ctx, cfg)).resolves.toEqual({ extractedFileImages: [] });
  expect(ctx.MediaUnderstandingDecisions).toContainEqual(
    expect.objectContaining({
      capability: "image",
      outcome: "skipped",
      nativeVisionActive: true,
      attachmentDispositions: { 0: { kind: "handed-to-native-vision" } },
    }),
  );
  expect(resolvePluginCapabilityProvidersSpy).not.toHaveBeenCalled();
});
