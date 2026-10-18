/** Protects plugin-owned web extractor dispatch and best-effort fallbacks. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginWebContentExtractorEntry } from "../plugins/web-content-extractor-types.js";

const { resolvePluginWebContentExtractorsMock } = vi.hoisted(() => ({
  resolvePluginWebContentExtractorsMock: vi.fn(),
}));

vi.mock("../plugins/web-content-extractors.runtime.js", () => ({
  resolvePluginWebContentExtractors: resolvePluginWebContentExtractorsMock,
}));

import { extractReadableContent } from "./content-extractors.runtime.js";

function createExtractor(
  id: string,
  extract: PluginWebContentExtractorEntry["extract"],
): PluginWebContentExtractorEntry {
  return { id, pluginId: id, label: id, extract };
}

describe("extractReadableContent", () => {
  const request = {
    html: "<article><p>raw html</p></article>",
    url: "https://example.com/article",
    extractMode: "text" as const,
    config: {},
  };

  beforeEach(() => {
    resolvePluginWebContentExtractorsMock.mockReset();
  });

  it("returns null when no extractor produces content", async () => {
    resolvePluginWebContentExtractorsMock.mockReturnValue([
      createExtractor("readability", vi.fn().mockResolvedValue(null)),
    ]);

    await expect(extractReadableContent(request)).resolves.toBeNull();
  });

  it("continues when a plugin extractor throws", async () => {
    resolvePluginWebContentExtractorsMock.mockReturnValue([
      createExtractor("broken", vi.fn().mockRejectedValue(new Error("boom"))),
      createExtractor(
        "readability",
        vi.fn().mockResolvedValue({ text: "fallback text", title: "Extracted" }),
      ),
    ]);

    await expect(extractReadableContent(request)).resolves.toEqual({
      extractor: "readability",
      text: "fallback text",
      title: "Extracted",
    });
  });

  it("returns null when extractor loading throws", async () => {
    resolvePluginWebContentExtractorsMock.mockImplementation(() => {
      throw new Error("loader boom");
    });

    await expect(extractReadableContent(request)).resolves.toBeNull();
  });
});
