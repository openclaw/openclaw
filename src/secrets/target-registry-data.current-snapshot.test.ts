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

  it("keeps official external channel secret targets without installed plugin metadata", async () => {
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");

    const ids = getSecretTargetRegistry().map((entry) => entry.id);

    expect(ids).toContain("channels.qqbot.clientSecret");
    expect(ids).toContain("channels.qqbot.accounts.*.clientSecret");
  });
});
