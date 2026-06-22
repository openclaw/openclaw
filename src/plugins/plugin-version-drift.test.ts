/** Tests plugin version drift detection between package, manifest, and install records. */
import { describe, expect, it } from "vitest";
import checkedInStablePluginSupportManifest from "../../release/stable-plugin-support.json" with { type: "json" };
import type { OpenClawConfig } from "../config/types.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  computeStablePluginSupportManifestSha256,
  detectPluginVersionDrift,
  generateStablePluginDriftReport,
  type StablePluginAcceptanceProof,
  type StablePluginRegistryProof,
  type StablePluginSupportManifest,
} from "./plugin-version-drift.js";

function npmRecord(
  version: string,
  overrides: Partial<PluginInstallRecord> = {},
): PluginInstallRecord {
  const resolvedName = overrides.resolvedName ?? "@openclaw/whatsapp";
  return {
    source: "npm",
    spec: `${resolvedName}@latest`,
    resolvedName,
    resolvedVersion: version,
    ...overrides,
  };
}

function clawhubRecord(
  version: string,
  overrides: Partial<PluginInstallRecord> = {},
): PluginInstallRecord {
  return {
    source: "clawhub",
    spec: "clawhub:@openclaw/whatsapp",
    clawhubPackage: "@openclaw/whatsapp",
    resolvedVersion: version,
    ...overrides,
  };
}

describe("detectPluginVersionDrift", () => {
  it("returns empty drifts when all externalized plugins match the gateway", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.4"),
        discord: npmRecord("2026.5.4", { resolvedName: "@openclaw/discord" }),
      },
    });

    expect(result.drifts).toEqual([]);
    expect(result.gatewayVersion).toBe("2026.5.4");
  });

  it("reports plugins whose installed version does not match the gateway", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.3", {
          resolvedName: "@openclaw/whatsapp",
          spec: "@openclaw/whatsapp@2026.5.3",
        }),
        discord: npmRecord("2026.5.4", { resolvedName: "@openclaw/discord" }),
      },
    });

    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0]).toEqual({
      pluginId: "whatsapp",
      installedVersion: "2026.5.3",
      gatewayVersion: "2026.5.4",
      source: "npm",
      packageName: "@openclaw/whatsapp",
      spec: "@openclaw/whatsapp@2026.5.3",
    });
  });

  it("treats a build-qualifier suffix on either side as matching (2026.5.4-1 ≈ 2026.5.4)", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4-1",
      installRecords: {
        whatsapp: npmRecord("2026.5.4"),
        // ...and the inverse direction
        discord: npmRecord("2026.5.4-1", { resolvedName: "@openclaw/discord" }),
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("includes ClawHub-installed plugins in the drift check", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: clawhubRecord("2026.5.3"),
      },
    });

    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0]?.source).toBe("clawhub");
  });

  it("includes official ClawHub installs whose catalog entry only declares npm install metadata", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        discord: clawhubRecord("2026.5.3", {
          spec: "clawhub:@openclaw/discord",
          clawhubPackage: "@openclaw/discord",
          clawhubChannel: "official",
          clawhubUrl: "https://clawhub.ai",
        }),
      },
    });

    expect(result.drifts.map((d) => d.pluginId)).toEqual(["discord"]);
  });

  it("ignores community npm installs without an official lockstep contract", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        community: npmRecord("1.2.3", {
          resolvedName: "community-plugin",
          spec: "community-plugin@1.2.3",
        }),
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("ignores community ClawHub installs without an official lockstep contract", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        community: clawhubRecord("1.2.3", {
          spec: "clawhub:community-plugin@1.2.3",
          clawhubPackage: "community-plugin",
        }),
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("ignores official catalog installs pinned to independent package versions", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        "openclaw-plugin-yuanbao": npmRecord("2.13.1", {
          resolvedName: "openclaw-plugin-yuanbao",
          spec: "openclaw-plugin-yuanbao@2.13.1",
        }),
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("ignores exact catalog pins even when the pin matches the gateway version", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.7",
      installRecords: {
        "wecom-openclaw-plugin": npmRecord("2026.5.6", {
          resolvedName: "@wecom/wecom-openclaw-plugin",
          spec: "@wecom/wecom-openclaw-plugin@2026.5.6",
        }),
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("ignores install sources that are not official external installs", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        // archive/path/git installs are local artifacts; they pin to whatever
        // the operator chose and should not be flagged on a gateway version
        // bump alone.
        archive: {
          source: "archive",
          resolvedName: "@openclaw/whatsapp",
          resolvedVersion: "2026.5.3",
          spec: "@openclaw/whatsapp@archive",
        },
        local: {
          source: "path",
          resolvedName: "@openclaw/whatsapp",
          resolvedVersion: "2026.5.3",
          spec: "/tmp/local-plugin",
        },
        forked: {
          source: "git",
          resolvedName: "@openclaw/whatsapp",
          resolvedVersion: "2026.5.3",
          spec: "git+ssh://example/forked",
        },
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("falls back to the install record's `version` field when `resolvedVersion` is absent", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: {
          source: "npm",
          spec: "@openclaw/whatsapp@latest",
          resolvedName: "@openclaw/whatsapp",
          version: "2026.5.3",
        },
      },
    });

    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0]?.installedVersion).toBe("2026.5.3");
  });

  it("skips plugins with no recorded version (cannot detect drift)", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: { source: "npm", spec: "@openclaw/whatsapp@latest" },
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("skips plugins that are explicitly disabled in config", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          whatsapp: { enabled: false },
          discord: { enabled: true },
        },
      },
    } as OpenClawConfig;

    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.3"),
        discord: npmRecord("2026.5.3", { resolvedName: "@openclaw/discord" }),
      },
      config,
    });

    expect(result.drifts.map((d) => d.pluginId)).toEqual(["discord"]);
  });

  it("skips plugins disabled by the global plugin activation policy", () => {
    const config: OpenClawConfig = {
      plugins: {
        enabled: false,
      },
    } as OpenClawConfig;

    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.3"),
      },
      config,
    });

    expect(result.drifts).toEqual([]);
  });

  it("skips plugins blocked by denylist or restrictive allowlist policy", () => {
    const denied = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.3"),
      },
      config: {
        plugins: {
          deny: ["whatsapp"],
        },
      } as OpenClawConfig,
    });
    const notAllowed = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.3"),
      },
      config: {
        plugins: {
          allow: ["discord"],
        },
      } as OpenClawConfig,
    });

    expect(denied.drifts).toEqual([]);
    expect(notAllowed.drifts).toEqual([]);
  });

  it("includes plugins with no entry in config (default-enabled)", () => {
    const config: OpenClawConfig = { plugins: { entries: {} } } as OpenClawConfig;
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.3"),
      },
      config,
    });

    expect(result.drifts).toHaveLength(1);
  });

  it("returns drifts sorted by pluginId for deterministic output", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        whatsapp: npmRecord("2026.5.3"),
        discord: npmRecord("2026.5.3", { resolvedName: "@openclaw/discord" }),
        matrix: npmRecord("2026.5.3", { resolvedName: "@openclaw/matrix" }),
      },
    });

    expect(result.drifts.map((d) => d.pluginId)).toEqual(["discord", "matrix", "whatsapp"]);
  });
});

const stableManifest = checkedInStablePluginSupportManifest as StablePluginSupportManifest;

function registryProofs(
  overrides: Partial<Record<string, Partial<StablePluginRegistryProof>>> = {},
): StablePluginRegistryProof[] {
  return stableManifest.coveredPlugins.map((entry) => ({
    packageName: entry.packageName,
    version: entry.targetVersion,
    targetNpmSpec: entry.targetNpmSpec,
    exists: true,
    observedAt: "2026-06-19T13:00:00.000Z",
    ...overrides[entry.packageName],
  }));
}

function acceptanceProofs(
  overrides: Partial<Record<string, Partial<StablePluginAcceptanceProof>>> = {},
): StablePluginAcceptanceProof[] {
  const manifestSha = computeStablePluginSupportManifestSha256(stableManifest);
  return stableManifest.coveredPlugins.map((entry) => ({
    packageName: entry.packageName,
    targetVersion: entry.targetVersion,
    targetNpmSpec: entry.targetNpmSpec,
    stablePluginSupportSha256: manifestSha,
    passed: true,
    completedAt: "2026-06-19T13:05:00.000Z",
    ...overrides[entry.packageName],
  }));
}

describe("generateStablePluginDriftReport", () => {
  it("reports ok for covered plugins with registry, catalog, proof, and installed match", () => {
    const report = generateStablePluginDriftReport({
      manifest: stableManifest,
      stableLine: {
        stableLine: "2026.6.33",
        updatedAt: "2026-06-19T12:00:00.000Z",
      },
      registryProofs: registryProofs(),
      acceptanceProofs: acceptanceProofs(),
      catalogEntries: [
        { packageName: "@openclaw/codex", pluginId: "codex", kind: "provider" },
        { packageName: "@openclaw/discord", pluginId: "discord", kind: "channel" },
        { packageName: "@openclaw/slack", pluginId: "slack", kind: "channel" },
      ],
      installedEntries: [
        {
          packageName: "@openclaw/slack",
          pluginId: "slack",
          installedVersion: "2026.6.33",
        },
      ],
      generatedAt: "2026-06-19T13:10:00.000Z",
    });

    expect(report.summary.blockingDriftCount).toBe(0);
    expect(report.rows.map((row) => row.status)).toEqual(["ok", "ok", "ok"]);
    expect(report.issues.every((issue) => issue.action === "none")).toBe(true);
  });

  it("reports registry_missing when an exact covered package target is absent", () => {
    const report = generateStablePluginDriftReport({
      manifest: stableManifest,
      registryProofs: registryProofs({
        "@openclaw/slack": { exists: false },
      }),
      acceptanceProofs: acceptanceProofs(),
    });

    expect(report.rows.find((row) => row.packageName === "@openclaw/slack")?.status).toBe(
      "registry_missing",
    );
  });

  it("reports proof_missing when registry proof exists but package acceptance proof is absent", () => {
    const report = generateStablePluginDriftReport({
      manifest: stableManifest,
      registryProofs: registryProofs(),
      acceptanceProofs: acceptanceProofs().filter(
        (proof) => proof.packageName !== "@openclaw/discord",
      ),
    });

    expect(report.rows.find((row) => row.packageName === "@openclaw/discord")?.status).toBe(
      "proof_missing",
    );
  });

  it("reports proof_stale when proof references an older manifest digest", () => {
    const report = generateStablePluginDriftReport({
      manifest: stableManifest,
      registryProofs: registryProofs(),
      acceptanceProofs: acceptanceProofs({
        "@openclaw/codex": { stablePluginSupportSha256: "old-digest" },
      }),
    });

    expect(report.rows.find((row) => row.packageName === "@openclaw/codex")?.status).toBe(
      "proof_stale",
    );
  });

  it("reports installed_drift when inspected local state differs from the stable target", () => {
    const report = generateStablePluginDriftReport({
      manifest: stableManifest,
      registryProofs: registryProofs(),
      acceptanceProofs: acceptanceProofs(),
      installedEntries: [
        {
          packageName: "@openclaw/slack",
          pluginId: "slack",
          installedVersion: "2026.6.32",
          spec: "@openclaw/slack@2026.6.32",
        },
      ],
    });

    expect(report.rows.find((row) => row.packageName === "@openclaw/slack")?.status).toBe(
      "installed_drift",
    );
  });

  it("reports catalog_drift when official catalog mapping no longer matches manifest", () => {
    const report = generateStablePluginDriftReport({
      manifest: stableManifest,
      registryProofs: registryProofs(),
      acceptanceProofs: acceptanceProofs(),
      catalogEntries: [
        { packageName: "@openclaw/discord", pluginId: "discord-v2", kind: "channel" },
      ],
    });

    expect(report.rows.find((row) => row.packageName === "@openclaw/discord")?.status).toBe(
      "catalog_drift",
    );
  });

  it("reports outside_stable_contract and dry-run issue decisions for non-covered installs", () => {
    const report = generateStablePluginDriftReport({
      manifest: stableManifest,
      registryProofs: registryProofs(),
      acceptanceProofs: acceptanceProofs(),
      installedEntries: [
        {
          packageName: "@openclaw/matrix",
          pluginId: "matrix",
          installedVersion: "2026.6.33",
        },
      ],
      updateIssues: false,
    });

    const outside = report.rows.find((row) => row.packageName === "@openclaw/matrix");
    expect(outside?.status).toBe("outside_stable_contract");
    expect(report.summary.outsideStableContractCount).toBe(1);
    expect(report.issues.find((issue) => issue.packageName === "@openclaw/matrix")?.action).toBe(
      "warn_only",
    );
  });

  it("uses stable idempotency markers for blocking dry-run issue decisions", () => {
    const report = generateStablePluginDriftReport({
      manifest: stableManifest,
      registryProofs: registryProofs({
        "@openclaw/slack": { exists: false },
      }),
      acceptanceProofs: acceptanceProofs(),
      updateIssues: false,
    });
    const issue = report.issues.find((entry) => entry.packageName === "@openclaw/slack");

    expect(issue?.action).toBe("dry_run_create_or_update");
    expect(issue?.idempotencyKey).toBe("2026.6.33:@openclaw/slack");
    expect(issue?.marker).toBe("<!-- openclaw:stable-plugin-drift:2026.6.33:@openclaw/slack -->");
  });
});
