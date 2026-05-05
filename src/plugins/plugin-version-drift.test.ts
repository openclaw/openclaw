import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { detectPluginVersionDrift } from "./plugin-version-drift.js";

function npmRecord(
  version: string,
  overrides: Partial<PluginInstallRecord> = {},
): PluginInstallRecord {
  return {
    source: "npm",
    spec: "@openclaw/example@latest",
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
    spec: "example@latest",
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
        discord: npmRecord("2026.5.4"),
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
        discord: npmRecord("2026.5.4"),
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
        discord: npmRecord("2026.5.4-1"),
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("includes ClawHub-installed plugins in the drift check", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        "post-update-awareness": clawhubRecord("0.1.0"),
      },
    });

    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0]?.source).toBe("clawhub");
  });

  it("ignores install sources that are not externalized npm/ClawHub installs", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        // archive/path/git installs are local artifacts; they pin to whatever
        // the operator chose and should not be flagged on a gateway version
        // bump alone.
        legacy: { source: "archive", resolvedVersion: "0.0.1", spec: "legacy@archive" },
        local: { source: "path", resolvedVersion: "0.0.1", spec: "/tmp/local-plugin" },
        forked: { source: "git", resolvedVersion: "0.0.1", spec: "git+ssh://example/forked" },
      },
    });

    expect(result.drifts).toEqual([]);
  });

  it("falls back to the install record's `version` field when `resolvedVersion` is absent", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        legacy: { source: "npm", spec: "@openclaw/legacy@latest", version: "2026.5.3" },
      },
    });

    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0]?.installedVersion).toBe("2026.5.3");
  });

  it("skips plugins with no recorded version (cannot detect drift)", () => {
    const result = detectPluginVersionDrift({
      gatewayVersion: "2026.5.4",
      installRecords: {
        unknown: { source: "npm", spec: "@openclaw/unknown@latest" },
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
        discord: npmRecord("2026.5.3"),
      },
      config,
    });

    expect(result.drifts.map((d) => d.pluginId)).toEqual(["discord"]);
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
        zeta: npmRecord("2026.5.3"),
        alpha: npmRecord("2026.5.3"),
        mu: npmRecord("2026.5.3"),
      },
    });

    expect(result.drifts.map((d) => d.pluginId)).toEqual(["alpha", "mu", "zeta"]);
  });
});
