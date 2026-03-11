import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";

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

describe("runCapability image skip", () => {
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

  it("does NOT skip image understanding when explicit imageModel is configured, even if primary model supports vision", async () => {
    const ctx: MsgContext = { MediaPath: "/tmp/image.png", MediaType: "image/png" };
    const media = normalizeMediaAttachments(ctx);
    const cache = createMediaAttachmentCache(media);
    const cfg = {
      agents: {
        defaults: {
          // Use openai so it has vision support in catalog
          imageModel: "openai/gpt-4-vision",
        },
      },
    } as OpenClawConfig;

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

      // The early-return skip injects a specific reason; a processing attempt should not have it
      expect(result.decision.attachments[0]?.attempts[0]?.reason).not.toBe(
        "primary model supports vision natively",
      );
      // At least one attempt should have been recorded (i.e., we didn't take the early return)
      expect(result.decision.attachments[0]?.attempts.length).toBeGreaterThan(0);
    } finally {
      await cache.cleanup();
    }
  });
});
