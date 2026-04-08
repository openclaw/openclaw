import { basename } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadPluginManifestRegistryMock } = vi.hoisted(() => ({
  loadPluginManifestRegistryMock: vi.fn(() => {
    throw new Error("manifest registry should stay off the explicit bundled channel fast path");
  }),
}));

vi.mock("../plugins/manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistry: loadPluginManifestRegistryMock,
  };
});

import {
  loadBundledChannelSecretContractApi,
  loadBundledChannelSecurityContractApi,
} from "./channel-contract-api.js";

describe("channel contract api explicit fast path", () => {
  beforeEach(() => {
    loadPluginManifestRegistryMock.mockClear();
  });

  it("resolves bundled channel secret contracts by explicit channel id without manifest scans", () => {
    const api = loadBundledChannelSecretContractApi("bluebubbles");

    expect(api?.collectRuntimeConfigAssignments).toBeTypeOf("function");
    expect(api?.secretTargetRegistryEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "channels.bluebubbles.accounts.*.password",
        }),
      ]),
    );
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves bundled channel security contracts by explicit channel id without manifest scans", () => {
    const api = loadBundledChannelSecurityContractApi("whatsapp");

    expect(api?.unsupportedSecretRefSurfacePatterns).toEqual(
      expect.arrayContaining(["channels.whatsapp.creds.json"]),
    );
    expect(api?.collectUnsupportedSecretRefConfigCandidates).toBeTypeOf("function");
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("keeps bundled channel ids aligned with their plugin directories", async () => {
    const { loadPluginManifestRegistry } = await vi.importActual<
      typeof import("../plugins/manifest-registry.js")
    >("../plugins/manifest-registry.js");

    const mismatches = loadPluginManifestRegistry({})
      .plugins.filter((record) => record.origin === "bundled")
      .filter((record) => typeof record.rootDir === "string" && record.rootDir.trim().length > 0)
      .flatMap((record) =>
        record.channels
          .filter((channelId) => channelId !== basename(record.rootDir))
          .map((channelId) => ({
            id: record.id,
            channelId,
            dirName: basename(record.rootDir),
          })),
      );

    expect(mismatches).toEqual([]);
  });
});
