import { describe, expect, it } from "vitest";
import { mediaKindFromMime } from "./constants.js";

describe("mediaKindFromMime", () => {
  it("classifies text mimes as document", () => {
    expect(mediaKindFromMime("text/plain")).toBe("document");
    expect(mediaKindFromMime("text/csv")).toBe("document");
    expect(mediaKindFromMime("text/html; charset=utf-8")).toBe("document");
  });

  it("keeps unknown mimes as unknown", () => {
    expect(mediaKindFromMime("model/gltf+json")).toBe("unknown");
  });
});
