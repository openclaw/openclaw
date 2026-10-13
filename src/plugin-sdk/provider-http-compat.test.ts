import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLegacyPluginMetadataSnapshotRuntime } from "../plugins/plugin-metadata-snapshot-required.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import {
  resolveProviderEndpoint,
  resolveProviderRequestCapabilities,
  resolveProviderRequestPolicy,
} from "./provider-http.js";
import { resolveProviderEndpoint as resolveModelEndpoint } from "./provider-model-shared.js";

vi.mock("../plugins/plugin-metadata-snapshot-required.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot-required.js")>()),
  loadLegacyPluginMetadataSnapshotRuntime: vi.fn(),
}));
vi.mock("../plugins/sdk-deprecation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/sdk-deprecation.js")>()),
  warnPluginSdkDeprecation: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

describe("provider HTTP legacy compatibility", () => {
  it("classifies cold URLs through both SDK facades and retains provider policy", () => {
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "sample",
          providerEndpoints: [{ endpointClass: "openai-public", hosts: ["api.example.com"] }],
          providerRequest: {
            providers: { sample: { family: "sample-family" } },
          },
        },
      ],
    });
    vi.mocked(loadLegacyPluginMetadataSnapshotRuntime).mockReturnValue(snapshot);
    const url = "https://api.example.com/v1";
    expect(resolveProviderEndpoint(url).endpointClass).toBe("openai-public");
    expect(resolveModelEndpoint(url).endpointClass).toBe("openai-public");
    expect(resolveProviderRequestPolicy({ provider: "sample", baseUrl: url })).toMatchObject({
      endpointClass: "openai-public",
      knownProviderFamily: "sample-family",
    });
    expect(resolveProviderRequestCapabilities({ provider: "openai", baseUrl: url })).toMatchObject({
      isKnownNativeEndpoint: true,
    });
    expect(warnPluginSdkDeprecation).toHaveBeenCalledWith(
      expect.objectContaining({ replacement: "prepareModelProviderRequestRouteFacts" }),
    );

    vi.mocked(loadLegacyPluginMetadataSnapshotRuntime).mockClear();
    expect(resolveProviderEndpoint(url, snapshot.owners).endpointClass).toBe("openai-public");
    expect(loadLegacyPluginMetadataSnapshotRuntime).not.toHaveBeenCalled();
  });
});
