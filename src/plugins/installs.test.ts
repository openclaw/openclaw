import { describe, expect, it } from "vitest";
import { recordPluginInstall, resolveNpmInstallRecordSpec } from "./installs.js";

describe("resolveNpmInstallRecordSpec", () => {
  it("uses an exact resolved registry spec when managed installs request pinning", () => {
    expect(
      resolveNpmInstallRecordSpec({
        requestedSpec: "@openclaw/codex",
        resolution: {
          name: "@openclaw/codex",
          version: "2026.5.30-beta.1",
          resolvedSpec: "@openclaw/codex@2026.5.30-beta.1",
        },
        pinResolvedRegistrySpec: true,
      }),
    ).toBe("@openclaw/codex@2026.5.30-beta.1");
  });

  it("does not replace the requested spec with tags or non-registry resolutions", () => {
    expect(
      resolveNpmInstallRecordSpec({
        requestedSpec: "@openclaw/codex",
        resolution: {
          name: "@openclaw/codex",
          version: "2026.5.30-beta.1",
          resolvedSpec: "@openclaw/codex@beta",
        },
        pinResolvedRegistrySpec: true,
      }),
    ).toBe("@openclaw/codex");
    expect(
      resolveNpmInstallRecordSpec({
        requestedSpec: "file:codex.tgz",
        resolution: {
          name: "@openclaw/codex",
          version: "2026.5.30-beta.1",
          resolvedSpec: "file:codex.tgz",
        },
        pinResolvedRegistrySpec: true,
      }),
    ).toBe("file:codex.tgz");
  });
});

describe("recordPluginInstall", () => {
  it("clears stale ClawHub trust metadata when a later install omits it", () => {
    const existing = recordPluginInstall(
      {},
      {
        pluginId: "demo",
        source: "clawhub",
        spec: "clawhub:demo@1.0.0",
        installPath: "/tmp/openclaw/plugins/demo",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubTrustDisposition: "review-required",
        clawhubTrustScanStatus: "suspicious",
        clawhubTrustReasons: ["payload_strings"],
        clawhubTrustPending: true,
        clawhubTrustCheckedAt: "2026-05-14T18:00:00.000Z",
        clawhubTrustAcknowledgedAt: "2026-05-14T18:00:03.000Z",
      },
    );

    const next = recordPluginInstall(existing, {
      pluginId: "demo",
      source: "clawhub",
      spec: "clawhub:demo@1.1.0",
      installPath: "/tmp/openclaw/plugins/demo",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "demo",
      clawhubFamily: "code-plugin",
      clawhubTrustDisposition: "clean",
      clawhubTrustCheckedAt: "2026-05-15T00:00:00.000Z",
      installedAt: "2026-05-15T00:00:03.000Z",
    });

    expect(next.plugins?.installs?.demo).toEqual({
      source: "clawhub",
      spec: "clawhub:demo@1.1.0",
      installPath: "/tmp/openclaw/plugins/demo",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "demo",
      clawhubFamily: "code-plugin",
      clawhubTrustDisposition: "clean",
      clawhubTrustCheckedAt: "2026-05-15T00:00:00.000Z",
      installedAt: "2026-05-15T00:00:03.000Z",
    });
  });

  it("moves an exact prior npm load path on same-version reinstall", () => {
    const previousInstallPath = "/tmp/openclaw/npm/projects/alpha-v1/node_modules/alpha";
    const nextInstallPath = "/tmp/openclaw/npm/projects/alpha-v2/node_modules/alpha";
    const customPath = `${previousInstallPath}/custom-child`;
    const adjacentPath = "/tmp/openclaw/npm/projects/beta/node_modules/beta";
    const existing = {
      plugins: {
        load: { paths: [customPath, previousInstallPath, adjacentPath] },
        installs: {
          alpha: {
            source: "npm" as const,
            spec: "alpha@1.0.0",
            installPath: previousInstallPath,
          },
          beta: {
            source: "npm" as const,
            spec: "beta@1.0.0",
            installPath: adjacentPath,
          },
        },
      },
    };

    const next = recordPluginInstall(existing, {
      pluginId: "alpha",
      source: "npm",
      spec: "alpha@1.0.0",
      installPath: nextInstallPath,
    });

    expect(next.plugins?.load?.paths).toEqual([customPath, nextInstallPath, adjacentPath]);
    expect(next.plugins?.installs?.beta).toBe(existing.plugins.installs.beta);
  });

  it("preserves an existing replacement path position while removing stale managed paths", () => {
    const previousInstallPath = "/tmp/openclaw/npm/projects/alpha-v1/node_modules/alpha";
    const nextInstallPath = "/tmp/openclaw/npm/projects/alpha-v2/node_modules/alpha";
    const adjacentPath = "/tmp/openclaw/npm/projects/beta/node_modules/beta";
    const existing = {
      plugins: {
        load: {
          paths: [nextInstallPath, adjacentPath, previousInstallPath, nextInstallPath],
        },
        installs: {
          alpha: {
            source: "npm" as const,
            spec: "alpha@1.0.0",
            installPath: previousInstallPath,
          },
        },
      },
    };

    const next = recordPluginInstall(existing, {
      pluginId: "alpha",
      source: "npm",
      spec: "alpha@1.0.0",
      installPath: nextInstallPath,
    });

    expect(next.plugins?.load?.paths).toEqual([nextInstallPath, adjacentPath]);
  });
});
