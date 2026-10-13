/** Tests runtime loading and sorting for plugin web content extractors. */
import { describe, expect, it, vi } from "vitest";
import { resolvePluginWebContentExtractorsAsync } from "./web-content-extractors.runtime.js";

// mock-isolation: fixture metadata and extractor factories replace installed machine-state preparation.
vi.mock("./installed-plugin-index-record-state.js", () => ({
  preparePluginMetadataMachineStateAsync: async () => () => {},
}));

describe("resolvePluginWebContentExtractorsAsync", () => {
  it("respects global plugin disablement", async () => {
    expect(
      await resolvePluginWebContentExtractorsAsync({
        config: {
          plugins: {
            enabled: false,
          },
        },
      }),
    ).toStrictEqual([]);
  });
});
