/** Tests target-registry data built from the current runtime snapshot. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const metadataMocks = vi.hoisted(() => ({
  resolvePluginMetadataSnapshot: vi.fn(() => ({ plugins: [] })),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: metadataMocks.resolvePluginMetadataSnapshot,
}));

describe("getSecretTargetRegistry metadata reuse", () => {
  beforeEach(() => {
    vi.resetModules();
    metadataMocks.resolvePluginMetadataSnapshot.mockClear();
    metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({ plugins: [] });
  });

  it("uses configless global metadata without a workspace-scoped current request", async () => {
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");

    getSecretTargetRegistry();

    expect(metadataMocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
    const calls = metadataMocks.resolvePluginMetadataSnapshot.mock.calls as unknown as Array<
      [{ allowWorkspaceScopedCurrent?: boolean }]
    >;
    for (const [call] of calls) {
      expect(call.allowWorkspaceScopedCurrent).not.toBe(true);
    }
  });

  it("registers secret targets for installed-origin plugins (#104320)", async () => {
    // Exa web providers moved from bundled origin to an installed package; the
    // gateway known-target registry must keep covering their credential paths.
    metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "exa",
          origin: "global",
          channels: [],
          contracts: { webSearchProviders: ["exa"] },
          configUiHints: { "webSearch.apiKey": { sensitive: true } },
          configContracts: {
            secretInputs: { paths: [{ path: "webSearch.apiKey" }] },
          },
        },
        {
          // Control: no web-provider contract / secretInputs → no fabricated target.
          id: "noise-plugin",
          origin: "global",
          channels: [],
          contracts: {},
          configUiHints: {},
        },
      ],
    } as never);
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");
    const { isKnownSecretTargetId } = await import("./target-registry-query.js");

    const ids = getSecretTargetRegistry().map((entry) => entry.id);

    expect(ids).toContain("plugins.entries.exa.config.webSearch.apiKey");
    expect(isKnownSecretTargetId("plugins.entries.exa.config.webSearch.apiKey")).toBe(true);
    expect(ids.some((id) => id.includes("noise-plugin"))).toBe(false);
  });
});
