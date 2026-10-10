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

  it.each([
    {
      name: "document-only pages",
      media: [{ path: "/tmp/scan.pdf", contentType: "application/pdf", hydrationSuppressed: true }],
      imageSourceIndexes: [0, 0],
      expected: {
        slots: [
          { kind: "inline", factIndex: 0 },
          { kind: "inline", factIndex: 0 },
        ],
      },
    },
    {
      name: "photo and multiple PDFs with suppressed and offloaded photos",
      media: [
        { path: "/tmp/inline.png", contentType: "image/png" },
        { path: "/tmp/first.pdf", contentType: "application/pdf", hydrationSuppressed: true },
        { path: "/tmp/described.png", contentType: "image/png", hydrationSuppressed: true },
        { path: "/tmp/second.pdf", contentType: "application/pdf", hydrationSuppressed: true },
        { path: "/tmp/offloaded.png", contentType: "image/png" },
      ],
      imageSourceIndexes: [0, 1, 1, 3, 3],
      expected: {
        slots: [
          { kind: "inline", factIndex: 0 },
          { kind: "inline", factIndex: 1 },
          { kind: "inline", factIndex: 1 },
          { kind: "inline", factIndex: 3 },
          { kind: "inline", factIndex: 3 },
          { kind: "offloaded", factIndex: 4 },
        ],
        suppressedFactIndexes: [2],
      },
    },
  ])("retains exact attachment ownership for $name", ({ media, imageSourceIndexes, expected }) => {
    const normalized = normalizeMediaFacts(media);
    expect(
      buildPersistedMediaImageLayout({
        ctx: {},
        media: normalized,
        ctxMediaCount: normalized.length,
        imageOrder: imageSourceIndexes.map(() => "inline"),
        imageSourceIndexes,
      }),
    ).toEqual(expected);
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
