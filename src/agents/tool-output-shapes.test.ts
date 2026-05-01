import { describe, expect, it } from "vitest";
import {
  classifyInternalToolOutputShape,
  hasProviderInventoryDetails,
} from "./tool-output-shapes.js";

describe("tool output internal shapes", () => {
  it.each(["image_generate", "video_generate"] as const)(
    "classifies %s provider inventory details",
    (toolName) => {
      expect(
        classifyInternalToolOutputShape({
          toolName,
          result: { details: { providers: [{ id: "openai" }] } },
        }),
      ).toBe("provider-inventory");
    },
  );

  it("keeps the provider inventory detector focused on the result shape", () => {
    expect(hasProviderInventoryDetails({ details: { providers: [] } })).toBe(true);
    expect(hasProviderInventoryDetails({ details: { providers: "openai" } })).toBe(false);
    expect(hasProviderInventoryDetails({ details: null })).toBe(false);
    expect(hasProviderInventoryDetails(null)).toBe(false);
  });

  it("does not classify unrelated tools with providers details", () => {
    expect(
      classifyInternalToolOutputShape({
        toolName: "web_search",
        result: { details: { providers: [{ id: "search" }] } },
      }),
    ).toBeUndefined();
  });

  it("does not classify media tools without provider inventory details", () => {
    expect(
      classifyInternalToolOutputShape({
        toolName: "image_generate",
        result: { details: { media: { url: "https://example.com/image.png" } } },
      }),
    ).toBeUndefined();
  });
});
