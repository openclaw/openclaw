import { describe, expect, it } from "vitest";
import { resolvePluginDocumentExtractors } from "./document-extractors.runtime.js";

describe("resolvePluginDocumentExtractors", () => {
  it("respects global plugin disablement", () => {
    expect(
      resolvePluginDocumentExtractors({
        config: {
          plugins: {
            enabled: false,
          },
        },
      }),
    ).toEqual([]);
  });

  it("does not expand an operator plugin allowlist", () => {
    expect(
      resolvePluginDocumentExtractors({
        config: {
          plugins: {
            allow: ["openai"],
          },
        },
      }),
    ).toEqual([]);
  });
});
