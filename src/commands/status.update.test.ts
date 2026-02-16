import { describe, expect, it } from "vitest";
import type { UpdateCheckResult } from "../infra/update-check.js";
import { VERSION } from "../version.js";
import { formatUpdateOneLiner, resolveUpdateAvailability } from "./status.update.js";

function buildUpdate(partial: Partial<UpdateCheckResult>): UpdateCheckResult {
  return {
    root: null,
    installKind: "unknown",
    packageManager: "unknown",
    ...partial,
  };
}

function nextMajorVersion(version: string): string {
  const [majorPart] = version.split(".");
  const major = Number.parseInt(majorPart ?? "", 10);
  if (Number.isFinite(major) && major >= 0) {
    return `${major + 1}.0.0`;
  }
  return "999999.0.0";
}

describe("resolveUpdateAvailability", () => {
  it("flags git update when behind upstream", () => {
    const update = buildUpdate({
      installKind: "git",
      git: {
        root: "/tmp/repo",
        sha: null,
        tag: null,
        branch: "main",
        upstream: "origin/main",
        dirty: false,
        ahead: 0,
        behind: 3,
        fetchOk: true,
      },
    });
    expect(resolveUpdateAvailability(update)).toEqual({
      available: true,
      hasGitUpdate: true,
      hasRegistryUpdate: false,
      latestVersion: null,
      gitBehind: 3,
    });
  });

  it("flags registry update when latest version is newer", () => {
    const latestVersion = nextMajorVersion(VERSION);
    const update = buildUpdate({
      installKind: "package",
      packageManager: "pnpm",
      registry: { latestVersion },
    });
    const availability = resolveUpdateAvailability(update);
    expect(availability.available).toBe(true);
    expect(availability.hasGitUpdate).toBe(false);
    expect(availability.hasRegistryUpdate).toBe(true);
    expect(availability.latestVersion).toBe(latestVersion);
  });
});

describe("formatUpdateOneLiner", () => {
  it("renders git status and registry latest summary", () => {
    const update = buildUpdate({
      installKind: "git",
      git: {
        root: "/tmp/repo",
        sha: "abc123456789",
        tag: null,
        branch: "main",
        upstream: "origin/main",
        dirty: true,
        ahead: 0,
        behind: 2,
        fetchOk: true,
      },
      registry: { latestVersion: VERSION },
      deps: {
        manager: "pnpm",
        status: "ok",
        lockfilePath: "pnpm-lock.yaml",
        markerPath: "node_modules/.modules.yaml",
      },
    });

    expect(formatUpdateOneLiner(update)).toBe(
      `Update: git main · ↔ origin/main · dirty · behind 2 · npm latest ${VERSION} · deps ok`,
    );
  });

  it("renders package-manager mode with registry error", () => {
    const update = buildUpdate({
      installKind: "package",
      packageManager: "npm",
      registry: { latestVersion: null, error: "offline" },
      deps: {
        manager: "npm",
        status: "missing",
        lockfilePath: "package-lock.json",
        markerPath: "node_modules",
      },
    });

    expect(formatUpdateOneLiner(update)).toBe("Update: npm · npm latest unknown · deps missing");
  });
});
