import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

const { channelTarget, loadArtifact, loadRegistry, loadManifest } = vi.hoisted(() => {
  const buildTarget = (id: string, refPathPattern?: string): SecretTargetRegistryEntry => ({
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
  const bundled = new Map([
    ["googlechat", buildTarget("channels.googlechat.serviceAccount")],
    ["telegram", buildTarget("channels.telegram.botToken", "channels.telegram.botTokenRef")],
  ]);
  return {
    channelTarget: buildTarget,
    loadArtifact: vi.fn(
      ({ artifactCandidates, dirName }: { artifactCandidates: string[]; dirName: string }) => {
        const entry =
          artifactCandidates[0] === "secret-contract-api.js" ? bundled.get(dirName) : undefined;
        return entry ? { secretTargetRegistryEntries: [entry] } : null;
      },
    ),
    loadRegistry: vi.fn(),
    loadManifest: vi.fn(() => {
      throw new Error("manifest registry should stay off configured-only target fast paths");
    }),
  };
});

// mock-isolation: Fail immediately if configured-only lookup discovers real plugin manifests.
vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: loadManifest,
}));
// mock-isolation: Supply secret-contract artifacts without loading bundled plugin code.
vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: loadArtifact,
}));
vi.mock("./target-registry-data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./target-registry-data.js")>();
  loadRegistry.mockImplementation((params?: { config?: OpenClawConfig }) => {
    const ids =
      params?.config?.plugins?.load?.paths?.[0] === "/plugins/custom-next"
        ? ["channels.customNext.token"]
        : [
            "channels.qqbot.clientSecret",
            "channels.custom.primaryToken",
            "channels.custom.secondaryToken",
          ];
    return [...actual.getCoreSecretTargetRegistry(), ...ids.map((id) => channelTarget(id))];
  });
  return { ...actual, getSecretTargetRegistry: loadRegistry };
});

import {
  discoverConfigSecretTargets,
  discoverConfigSecretTargetsByIds,
  resolveConfigSecretTargetByPath,
  resolvePlanTargetAgainstRegistry,
} from "./target-registry.js";

beforeEach(() => {
  for (const mock of [loadManifest, loadArtifact, loadRegistry]) {
    mock.mockClear();
  }
});
afterEach(() => expect(loadManifest).not.toHaveBeenCalled());

it("resolves bundled channel targets without manifest scans", () => {
  const target = resolveConfigSecretTargetByPath(["channels", "googlechat", "serviceAccount"]);
  expect(target?.entry.id).toBe("channels.googlechat.serviceAccount");
  expect(target?.refPathSegments).toBeUndefined();
  expect(loadArtifact).toHaveBeenCalledWith({
    dirName: "googlechat",
    artifactCandidates: ["secret-contract-api.js"],
  });
  expect(loadRegistry).not.toHaveBeenCalled();
});

it("discovers selected configured channel targets without plugin metadata", () => {
  const targets = discoverConfigSecretTargetsByIds(
    { channels: { telegram: { botToken: "test-token" } } },
    ["channels.telegram.botToken"],
  );
  expect(targets.map((target) => target.entry.id)).toContain("channels.telegram.botToken");
});

it("uses the complete registry for external channels and changed plugin paths", () => {
  const env = { HOME: "/audit-home" };
  const discover = (config: OpenClawConfig) => {
    const targets = discoverConfigSecretTargets(config, { env });
    expect(loadRegistry).toHaveBeenLastCalledWith({ config, env, configuredOnly: true });
    return targets.map((target) => target.entry.id);
  };
  expect(
    discover({
      plugins: { load: { paths: ["/plugins/custom"] }, entries: {} },
      channels: {
        qqbot: { clientSecret: "qqbot-secret" },
        custom: { primaryToken: "primary-secret", secondaryToken: "secondary-secret" },
      },
    }),
  ).toEqual(
    expect.arrayContaining([
      "channels.qqbot.clientSecret",
      "channels.custom.primaryToken",
      "channels.custom.secondaryToken",
    ]),
  );
  expect(
    discover({
      plugins: { load: { paths: ["/plugins/custom-next"] }, entries: {} },
      channels: { customNext: { token: "next-secret" } },
    }),
  ).toContain("channels.customNext.token");
});

it.each([
  ["channels.telegram.botToken", ["channels", "telegram", "botToken"]],
  ["auth-profiles.api_key.key", ["profiles", "openai:default", "key"]],
] as const)("resolves %s plan targets without plugin metadata", (type, pathSegments) => {
  const target = resolvePlanTargetAgainstRegistry({ type, pathSegments: [...pathSegments] });
  expect(target?.entry.id).toBe(type);
});
