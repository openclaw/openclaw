import { describe, expect, it } from "vitest";
import { normalizeMediaFacts } from "../../media/media-facts.js";
import {
  buildPersistedMediaImageLayout,
  suppressUnresolvedPromptMedia,
} from "./get-reply-run-helpers.js";

describe("persisted media image layout", () => {
  it.each([
    { name: "filename-only SVG", media: { path: "/tmp/diagram.svg" }, image: false },
    {
      name: "explicit image-kind SVG",
      media: { path: "/tmp/diagram.svg", kind: "image" as const },
      image: true,
    },
    {
      name: "separate image filename with opaque source",
      media: {
        url: "https://cdn.example.test/download/opaque",
        fileName: "photo.png",
        contentType: "application/octet-stream",
      },
      image: true,
    },
  ])("classifies $name through the real persisted-layout owner", ({ media, image }) => {
    const normalized = normalizeMediaFacts([media]);
    const layout = buildPersistedMediaImageLayout({
      ctx: {},
      media: normalized,
      ctxMediaCount: normalized.length,
    });

    expect(layout).toEqual(image ? { slots: [{ kind: "offloaded", factIndex: 0 }] } : undefined);
  });

  it("does not resurrect hydration-suppressed image facts as offloaded slots", () => {
    const normalized = normalizeMediaFacts([
      { path: "/tmp/readable.png", contentType: "image/png" },
      {
        path: "/tmp/missing.png",
        contentType: "image/png",
        hydrationSuppressed: true,
      },
    ]);
    const layout = buildPersistedMediaImageLayout({
      ctx: {},
      media: normalized,
      ctxMediaCount: normalized.length,
      imageOrder: ["inline"],
      imageSourceIndexes: [0],
    });

    expect(layout?.slots).toEqual([{ kind: "inline", factIndex: 0 }]);
    expect(layout?.suppressedFactIndexes).toEqual([1]);
  });

  it("suppresses only the unresolved fact when prompt media share a path", () => {
    const sharedPath = "/tmp/shared.png";
    const suppressed = suppressUnresolvedPromptMedia({
      promptMedia: [
        { path: sharedPath, contentType: "image/png" },
        { path: sharedPath, contentType: "image/png" },
      ],
      inboundMediaIndexes: [0, 1],
      unresolvedSourceIndexes: new Set([1]),
    });

    expect(suppressed[0]).not.toHaveProperty("hydrationSuppressed");
    expect(suppressed[1]).toMatchObject({ hydrationSuppressed: true });
  });

  it("leaves prompt media untouched when nothing is unresolved", () => {
    const suppressed = suppressUnresolvedPromptMedia({
      promptMedia: [{ path: "/tmp/a.png", contentType: "image/png" }],
      inboundMediaIndexes: [0],
      unresolvedSourceIndexes: new Set(),
    });

    expect(suppressed[0]).not.toHaveProperty("hydrationSuppressed");
  });
});
