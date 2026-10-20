import { describe, expect, it } from "vitest";
import { normalizeMediaReferenceForComparison as normalize } from "./media-reference-comparison.js";

describe("normalizeMediaReferenceForComparison", () => {
  it("matches encoded file URLs with equivalent absolute paths", () => {
    expect(normalizeMediaReferenceForComparison("file:///tmp/generated%20image.png")).toBe(
      normalizeMediaReferenceForComparison("/tmp/generated image.png"),
    );
  });

  it.each([
    ["FILE:/workspace/a%5Cb.png", "/workspace/a\\b.png"],
    ["FILE:/workspace/a%5cb.png", "/workspace/a\\b.png"],
    ["FILE:/workspace/a%2Fb.png", "/workspace/a/b.png"],
    ["FILE:/workspace/a%2fb.png", "/workspace/a/b.png"],
  ])("preserves encoded separator URL %s without colliding with %s", (fileUrl, localPath) => {
    expect(normalizeMediaReferenceForComparison(fileUrl)).toBe(fileUrl);
    expect(normalizeMediaReferenceForComparison(fileUrl)).not.toBe(
      normalizeMediaReferenceForComparison(localPath),
    );
  });

  it.each(["file:/tmp/generated.png", "FILE:/tmp/generated.png", "FILE:///tmp/generated.png"])(
    "matches canonical file URL form %s with the triple-slash form",
    (fileUrl) => {
      expect(normalizeMediaReferenceForComparison(fileUrl)).toBe(
        normalizeMediaReferenceForComparison("file:///tmp/generated.png"),
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "matches Windows network file URLs across scheme casing",
    () => {
      expect(normalize("FILE://server/share.png")).toBe(normalize("file://server/share.png"));
    },
  );

  it("keeps parent segments distinct without resolving filesystem identity", () => {
    expect(normalizeMediaReferenceForComparison("/tmp/output/../generated.png")).toBe(
      "/tmp/output/../generated.png",
    );
  });

  it("applies URL parent-segment semantics before filesystem comparison", () => {
    expect(normalizeMediaReferenceForComparison("file:///tmp/output/../generated.png")).toBe(
      normalizeMediaReferenceForComparison("/tmp/generated.png"),
    );
    expect(normalizeMediaReferenceForComparison("file:///tmp/output/%2e%2e/generated.png")).toBe(
      normalizeMediaReferenceForComparison("/tmp/generated.png"),
    );
  });

  it("normalizes safe absolute path syntax symmetrically", () => {
    expect(normalizeMediaReferenceForComparison("/tmp/output/./generated.png")).toBe(
      normalizeMediaReferenceForComparison("file:///tmp/output/./generated.png"),
    );
  });

  it("preserves remote and relative references after trimming", () => {
    expect(normalize(" https://example.test/a/../b.png ")).toBe("https://example.test/a/../b.png");
    expect(normalize("./output/../generated.png")).toBe("./output/../generated.png");
    expect(normalize("file://server/share.png")).not.toBe(normalize("server/share.png"));
    expect(normalize("FILE://server/share.png")).not.toBe(normalize("server/share.png"));
    expect(normalize("FILE:/tmp/a%2Fb.png")).not.toBe(normalize("/tmp/a/b.png"));
    expect(normalize("//cdn.example/share.png")).toBe("//cdn.example/share.png");
    expect(normalize("//cdn.example/share.png")).not.toBe(normalize("/cdn.example/share.png"));
    expect(normalize("file:////cdn.example/share.png")).not.toBe(
      normalize("//cdn.example/share.png"),
    );
    expect(normalize("file:////cdn.example/share.png")).not.toBe(
      normalize("/cdn.example/share.png"),
    );
    expect(normalize("file:////cdn.example/a//share.png")).toBe(
      normalize("file:////cdn.example/a/share.png"),
    );
  });

  it("keeps malformed local file URLs comparable with their paths", () => {
    expect(normalize("file:///tmp/100%.png")).toBe(normalize("/tmp/100%.png"));
    expect(normalize("file:///tmp/link/../asset%.png")).toBe("/tmp/link/../asset%.png");
  });
});
