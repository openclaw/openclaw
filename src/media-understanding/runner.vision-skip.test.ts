import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";

const catalog = [
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    input: ["text", "image"] as const,
  },
];

const loadModelCatalog = vi.hoisted(() => vi.fn(async () => catalog));

vi.mock("../agents/model-catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/model-catalog.js")>(
    "../agents/model-catalog.js",
  );
  return {
    ...actual,
    loadModelCatalog,
  };
});

let buildProviderRegistry: typeof import("./runner.js").buildProviderRegistry;
let createMediaAttachmentCache: typeof import("./runner.js").createMediaAttachmentCache;
let normalizeMediaAttachments: typeof import("./runner.js").normalizeMediaAttachments;
let runCapability: typeof import("./runner.js").runCapability;

describe("runCapability image skip", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../agents/model-catalog.js", async () => {
      const actual = await vi.importActual<typeof import("../agents/model-catalog.js")>(
        "../agents/model-catalog.js",
      );
      return {
        ...actual,
        loadModelCatalog,
      };
    });
    ({
      buildProviderRegistry,
      createMediaAttachmentCache,
      normalizeMediaAttachments,
      runCapability,
    } = await import("./runner.js"));
    loadModelCatalog.mockClear();
  });

  it("skips image understanding when the active model supports vision", async () => {
    const ctx: MsgContext = { MediaPath: "/tmp/image.png", MediaType: "image/png" };
    const media = normalizeMediaAttachments(ctx);
    const cache = createMediaAttachmentCache(media);
    const cfg = {} as OpenClawConfig;

    try {
      const result = await runCapability({
        capability: "image",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry: buildProviderRegistry(),
        activeModel: { provider: "openai", model: "gpt-4.1" },
      });

      expect(result.outputs).toHaveLength(0);
      expect(result.decision.outcome).toBe("skipped");
      expect(result.decision.attachments).toHaveLength(1);
      expect(result.decision.attachments[0]?.attachmentIndex).toBe(0);
      expect(result.decision.attachments[0]?.attempts[0]?.outcome).toBe("skipped");
      expect(result.decision.attachments[0]?.attempts[0]?.reason).toBe(
        "primary model supports vision natively",
      );
    } finally {
      await cache.cleanup();
    }
  });
});
