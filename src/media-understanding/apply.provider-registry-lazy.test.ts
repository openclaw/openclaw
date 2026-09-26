// Regression test for the lazy-provider-registry fix: applyMediaUnderstanding
// must not build the media-understanding provider registry on a turn whose
// native-vision skip branch never reads it.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";

type TestCatalogEntry = { id: string; name: string; provider: string; input: readonly string[] };

const baseCatalog: TestCatalogEntry[] = [
  { id: "gpt-5.4", name: "GPT-5.4", provider: "usage-proxy", input: ["text", "image"] as const },
];
let catalog: TestCatalogEntry[] = [...baseCatalog];

const loadModelCatalog = vi.hoisted(() => vi.fn(async (_params: unknown) => catalog));
const resolvePluginCapabilityProvidersSpy = vi.hoisted(() => vi.fn());

vi.mock("../agents/image-compression-policy.js", () => ({
  resolveImageCompressionModelPolicy: vi.fn(async () => ({})),
}));

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

// A "mediaUnderstandingProviders" lookup is the registry build these tests
// assert on; other keys are ignored, as in runner.vision-skip.test.ts.
vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: (params: { key: string }) => {
    if (params.key === "mediaUnderstandingProviders") {
      resolvePluginCapabilityProvidersSpy(params);
    }
    return [];
  },
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: loadModelCatalog,
}));

let applyMediaUnderstanding: typeof import("./apply.js").applyMediaUnderstanding;

describe("applyMediaUnderstanding - lazy provider registry", () => {
  beforeAll(async () => {
    ({ applyMediaUnderstanding } = await import("./apply.js"));
  });

  beforeEach(() => {
    catalog = [...baseCatalog];
    resolvePluginCapabilityProvidersSpy.mockClear();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  async function runImageTurn(cfg: OpenClawConfig) {
    const ctx: MsgContext = { media: [{ path: "/tmp/image.png", contentType: "image/png" }] };
    return await applyMediaUnderstanding({
      ctx,
      cfg,
      activeModel: { provider: "usage-proxy", model: "gpt-5.4" },
    });
  }

  it("native vision active, no explicit tools.media.models -> registry never built", async () => {
    const cfg = {
      models: {
        providers: { "usage-proxy": { models: [{ id: "gpt-5.4", input: ["text", "image"] }] } },
      },
    } as unknown as OpenClawConfig;

    await runImageTurn(cfg);

    expect(resolvePluginCapabilityProvidersSpy).not.toHaveBeenCalled();
  });

  it("native vision active, but an explicit tools.media.models entry is configured -> registry built as before", async () => {
    const cfg = {
      models: {
        providers: { "usage-proxy": { models: [{ id: "gpt-5.4", input: ["text", "image"] }] } },
      },
      tools: { media: { models: [{ provider: "usage-proxy", capabilities: ["image"] }] } },
    } as unknown as OpenClawConfig;

    await runImageTurn(cfg);

    expect(resolvePluginCapabilityProvidersSpy).toHaveBeenCalled();
  });

  it("a non-vision active model -> registry built as before (catalog fallback path)", async () => {
    catalog = [{ id: "gpt-5.4", name: "GPT-5.4", provider: "usage-proxy", input: ["text"] as const }];
    const cfg = {} as OpenClawConfig;

    await runImageTurn(cfg);

    expect(resolvePluginCapabilityProvidersSpy).toHaveBeenCalled();
  });

  it("mixed image+audio attachment turn: image's own skip branch never reads the registry, audio's non-skip path does -- built exactly once", async () => {
    // Only image has a native-vision skip branch: audio still builds the
    // registry, once, through the memoized factory both capabilities share.
    const cfg = {
      models: {
        providers: { "usage-proxy": { models: [{ id: "gpt-5.4", input: ["text", "image"] }] } },
      },
    } as unknown as OpenClawConfig;
    const ctx: MsgContext = {
      media: [
        { path: "/tmp/image.png", contentType: "image/png" },
        { path: "/tmp/note.ogg", contentType: "audio/ogg" },
      ],
    };

    await applyMediaUnderstanding({
      ctx,
      cfg,
      activeModel: { provider: "usage-proxy", model: "gpt-5.4" },
    });

    expect(resolvePluginCapabilityProvidersSpy).toHaveBeenCalledTimes(1);
  });
});
