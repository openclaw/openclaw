import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type PnpmBuildConfig = {
  allowBuilds?: Record<string, boolean>;
  blockExoticSubdeps?: boolean;
  ignoredBuiltDependencies?: string[];
  minimumReleaseAgeIgnoreMissingTime?: boolean;
  minimumReleaseAgeStrict?: boolean;
  onlyBuiltDependencies?: string[];
};

type RootPackageJson = {
  pnpm?: PnpmBuildConfig;
};

type WorkspaceConfig = PnpmBuildConfig;

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

describe("package manager build policy", () => {
  it("keeps optional native Discord opus builds disabled by default", () => {
    const packageJson = readJson("package.json") as RootPackageJson;
    const workspace = parse(fs.readFileSync("pnpm-workspace.yaml", "utf8")) as WorkspaceConfig;

    expect(packageJson.pnpm).toBeUndefined();
    expect(workspace.allowBuilds?.["@discordjs/opus"]).toBe(false);
    expect(workspace.blockExoticSubdeps).toBe(true);
    expect(workspace.onlyBuiltDependencies).toBeUndefined();
  });

  it("keeps exotic subdependency builds blocked by default", () => {
    const workspace = parse(fs.readFileSync("pnpm-workspace.yaml", "utf8")) as WorkspaceConfig;

    expect(workspace.allowBuilds?.["baileys"]).toBe(true);
    expect(workspace.allowBuilds?.["@whiskeysockets/libsignal-node"]).toBeUndefined();
    expect(workspace.blockExoticSubdeps).toBe(true);
  });

  it("does not relax release-age installs for missing registry publish metadata", () => {
    const workspace = parse(fs.readFileSync("pnpm-workspace.yaml", "utf8")) as WorkspaceConfig;

    expect(workspace.minimumReleaseAgeIgnoreMissingTime).toBeUndefined();
    expect(workspace.minimumReleaseAgeStrict).toBeUndefined();
  });
});
