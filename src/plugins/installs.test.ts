import { describe, expect, it } from "vitest";
import { recordPluginInstall, resolveNpmInstallRecordSpec } from "./installs.js";

const name = "@openclaw/codex";
const version = "2026.5.30-beta.1";
const exactSpec = `${name}@${version}`;
const pinnedSpec = (requestedSpec: string, resolvedSpec: string) =>
  resolveNpmInstallRecordSpec({
    requestedSpec,
    resolution: { name, version, resolvedSpec },
    pinResolvedRegistrySpec: true,
  });
const previousInstallPath = "/tmp/openclaw/npm/projects/alpha-v1/node_modules/alpha";
const nextInstallPath = "/tmp/openclaw/npm/projects/alpha-v2/node_modules/alpha";
const adjacentPath = "/tmp/openclaw/npm/projects/beta/node_modules/beta";
const npmInstall = (installPath: string, spec = "alpha@1.0.0") => ({
  source: "npm" as const,
  spec,
  installPath,
});

describe("resolveNpmInstallRecordSpec", () => {
  it("uses an exact resolved registry spec when managed installs request pinning", () => {
    expect(pinnedSpec(name, exactSpec)).toBe(exactSpec);
  });

  it("does not replace the requested spec with tags or non-registry resolutions", () => {
    expect(pinnedSpec(name, `${name}@beta`)).toBe(name);
    expect(pinnedSpec("file:codex.tgz", "file:codex.tgz")).toBe("file:codex.tgz");
  });
});

describe("recordPluginInstall", () => {
  it("clears stale ClawHub trust metadata when a later install omits it", () => {
    const identity = {
      pluginId: "demo",
      source: "clawhub" as const,
      installPath: "/tmp/openclaw/plugins/demo",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "demo",
      clawhubFamily: "code-plugin" as const,
    };
    const existing = recordPluginInstall(
      {},
      {
        ...identity,
        spec: "clawhub:demo@1.0.0",
        clawhubTrustDisposition: "review-required",
        clawhubTrustScanStatus: "suspicious",
        clawhubTrustReasons: ["payload_strings"],
        clawhubTrustPending: true,
        clawhubTrustCheckedAt: "2026-05-14T18:00:00.000Z",
        clawhubTrustAcknowledgedAt: "2026-05-14T18:00:03.000Z",
      },
    );

    const update = {
      spec: "clawhub:demo@1.1.0",
      clawhubTrustDisposition: "clean" as const,
      clawhubTrustCheckedAt: "2026-05-15T00:00:00.000Z",
      installedAt: "2026-05-15T00:00:03.000Z",
    };
    const next = recordPluginInstall(existing, { ...identity, ...update });
    const { pluginId: _pluginId, ...recordIdentity } = identity;
    expect(next.plugins?.installs?.demo).toEqual({ ...recordIdentity, ...update });
  });

  it.each([
    {
      name: "moves the prior slot without moving custom children",
      paths: [`${previousInstallPath}/custom-child`, previousInstallPath, adjacentPath],
      expected: [`${previousInstallPath}/custom-child`, nextInstallPath, adjacentPath],
    },
    {
      name: "preserves the replacement slot and removes stale duplicates",
      paths: [nextInstallPath, adjacentPath, previousInstallPath, nextInstallPath],
      expected: [nextInstallPath, adjacentPath],
    },
  ])("$name on same-version reinstall", ({ paths, expected }) => {
    const existing = {
      plugins: {
        load: { paths },
        installs: {
          alpha: npmInstall(previousInstallPath),
          beta: npmInstall(adjacentPath, "beta@1.0.0"),
        },
      },
    };

    const next = recordPluginInstall(existing, {
      pluginId: "alpha",
      ...npmInstall(nextInstallPath),
    });

    expect(next.plugins?.load?.paths).toEqual(expected);
    expect(next.plugins?.installs?.beta).toBe(existing.plugins.installs.beta);
  });
});
