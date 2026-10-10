/** Tests that configured-only secret target lookup avoids broad manifest rediscovery. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

const { loadPluginManifestRegistryMock } = vi.hoisted(() => ({
  loadPluginManifestRegistryMock: vi.fn(() => {
    throw new Error("manifest registry should stay off configured-only target fast paths");
  }),
}));

const { getSecretTargetRegistryMock } = vi.hoisted(() => ({
  getSecretTargetRegistryMock: vi.fn(),
}));

const { channelTarget, loadBundledPublicArtifactMock } = vi.hoisted(() => {
  const buildChannelTarget = (id: string, refPathPattern?: string): SecretTargetRegistryEntry => ({
    id,
    targetType: id,
    configFile: "openclaw.json",
    pathPattern: id,
    ...(refPathPattern ? { refPathPattern } : {}),
    secretShape: refPathPattern ? "sibling_ref" : "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  });
  const loadArtifact = vi.fn(
    ({ artifactCandidates, dirName }: { artifactCandidates: string[]; dirName: string }) => {
      if (dirName === "googlechat" && artifactCandidates[0] === "secret-contract-api.js") {
        return {
          secretTargetRegistryEntries: [buildChannelTarget("channels.googlechat.serviceAccount")],
        };
      }
      if (dirName === "telegram" && artifactCandidates[0] === "secret-contract-api.js") {
        return {
          secretTargetRegistryEntries: [
            buildChannelTarget("channels.telegram.botToken", "channels.telegram.botTokenRef"),
          ],
        };
      }
      return null;
    },
  );
  return { channelTarget: buildChannelTarget, loadBundledPublicArtifactMock: loadArtifact };
});

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: loadPluginManifestRegistryMock,
}));

vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: loadBundledPublicArtifactMock,
}));

vi.mock("./target-registry-data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./target-registry-data.js")>();
  getSecretTargetRegistryMock.mockImplementation(
    (params?: { config?: { plugins?: { load?: { paths?: string[] } } } }) => {
      const loadPath = params?.config?.plugins?.load?.paths?.[0];
      const channelEntries =
        loadPath === "/plugins/custom-next"
          ? [channelTarget("channels.customNext.token")]
          : [
              channelTarget("channels.qqbot.clientSecret"),
              channelTarget("channels.custom.primaryToken"),
              channelTarget("channels.custom.secondaryToken"),
            ];
      return [...actual.getCoreSecretTargetRegistry(), ...channelEntries];
    },
  );
  return { ...actual, getSecretTargetRegistry: getSecretTargetRegistryMock };
});

import {
  discoverConfigSecretTargets,
  discoverConfigSecretTargetsByIds,
  resolveConfigSecretTargetByPath,
  resolvePlanTargetAgainstRegistry,
} from "./target-registry.js";

describe("secret target registry fast path", () => {
  beforeEach(() => {
    loadPluginManifestRegistryMock.mockClear();
    loadBundledPublicArtifactMock.mockClear();
    getSecretTargetRegistryMock.mockClear();
  });

  it("resolves bundled channel targets by explicit channel id without manifest scans", () => {
    const target = resolveConfigSecretTargetByPath(["channels", "googlechat", "serviceAccount"]);

    if (!target) {
      throw new Error("expected googlechat service account target");
    }
    expect(target.entry.id).toBe("channels.googlechat.serviceAccount");
    expect(target.refPathSegments).toBeUndefined();
    expect(loadBundledPublicArtifactMock).toHaveBeenCalledWith({
      dirName: "googlechat",
      artifactCandidates: ["secret-contract-api.js"],
    });
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
    expect(getSecretTargetRegistryMock).not.toHaveBeenCalled();
  });

  it("discovers selected configured channel targets without loading plugin metadata", () => {
    const targets = discoverConfigSecretTargetsByIds(
      { channels: { telegram: { botToken: "test-token" } } },
      ["channels.telegram.botToken"],
    );

    expect(targets.map((target) => target.entry.id)).toContain("channels.telegram.botToken");
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("uses the complete registry for configured external and custom channels", () => {
    const env = { HOME: "/audit-home" };
    const config = {
      plugins: { load: { paths: ["/plugins/custom"] }, entries: {} },
      channels: {
        qqbot: { clientSecret: "qqbot-secret" },
        custom: {
          primaryToken: "primary-secret",
          secondaryToken: "secondary-secret",
        },
      },
    };
    const targets = discoverConfigSecretTargets(config, { env });

    expect(targets.map((target) => target.entry.id)).toEqual(
      expect.arrayContaining([
        "channels.qqbot.clientSecret",
        "channels.custom.primaryToken",
        "channels.custom.secondaryToken",
      ]),
    );
    expect(getSecretTargetRegistryMock).toHaveBeenLastCalledWith({ config, env });

    const nextConfig = {
      plugins: { load: { paths: ["/plugins/custom-next"] }, entries: {} },
      channels: { customNext: { token: "next-secret" } },
    };
    const nextTargets = discoverConfigSecretTargets(nextConfig, { env });
    expect(nextTargets.map((target) => target.entry.id)).toContain("channels.customNext.token");
    expect(getSecretTargetRegistryMock).toHaveBeenLastCalledWith({ config: nextConfig, env });
  });

  it("resolves channel plan targets without loading plugin metadata", () => {
    const target = resolvePlanTargetAgainstRegistry({
      type: "channels.telegram.botToken",
      pathSegments: ["channels", "telegram", "botToken"],
    });

    expect(target?.entry.id).toBe("channels.telegram.botToken");
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves auth-profile plan targets without loading plugin metadata", () => {
    const target = resolvePlanTargetAgainstRegistry({
      type: "auth-profiles.api_key.key",
      pathSegments: ["profiles", "openai:default", "key"],
    });

    expect(target?.entry.id).toBe("auth-profiles.api_key.key");
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });
});
