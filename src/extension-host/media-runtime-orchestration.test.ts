import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  createMediaAttachmentCache,
  normalizeMediaAttachments,
} from "../media-understanding/runner.js";
import { runCapability } from "./media-runtime-orchestration.js";
import { buildExtensionHostMediaUnderstandingRegistry } from "./media-runtime-registry.js";

const catalog = [
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    input: ["text", "image"] as const,
  },
];

vi.mock("../agents/model-catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/model-catalog.js")>(
    "../agents/model-catalog.js",
  );
  return {
    ...actual,
    loadModelCatalog: vi.fn(async () => catalog),
  };
});

describe("media runtime orchestration", () => {
  it("skips image understanding when the active model already supports vision", async () => {
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
        providerRegistry: buildExtensionHostMediaUnderstandingRegistry(),
        activeModel: { provider: "openai", model: "gpt-4.1" },
      });

      expect(result.outputs).toHaveLength(0);
      expect(result.decision.outcome).toBe("skipped");
      expect(result.decision.attachments).toHaveLength(1);
      expect(result.decision.attachments[0]?.attempts[0]?.reason).toBe(
        "primary model supports vision natively",
      );
    } finally {
      await cache.cleanup();
    }
  });
});
