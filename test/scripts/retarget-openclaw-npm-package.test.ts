import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  retargetOpenClawNpmPackage,
  validateForkNpmPackageTarget,
} from "../../scripts/retarget-openclaw-npm-package.mjs";

const tempDirs: string[] = [];

function makePackageRoot(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "openclaw-fork-npm-"));
  tempDirs.push(rootDir);
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(
    path.join(rootDir, "package.json"),
    `${JSON.stringify(
      {
        name: "openclaw",
        version: "2026.7.1-beta.1",
        homepage: "https://github.com/openclaw/openclaw#readme",
        bugs: { url: "https://github.com/openclaw/openclaw/issues" },
        repository: { type: "git", url: "git+https://github.com/openclaw/openclaw.git" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(rootDir, "npm-shrinkwrap.json"),
    `${JSON.stringify(
      {
        name: "openclaw",
        version: "2026.7.1-beta.1",
        lockfileVersion: 3,
        packages: { "": { name: "openclaw", version: "2026.7.1-beta.1" } },
      },
      null,
      2,
    )}\n`,
  );
  return rootDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("retargetOpenClawNpmPackage", () => {
  it("retargets only the published package identity and registry", () => {
    const rootDir = makePackageRoot();

    expect(
      retargetOpenClawNpmPackage({
        packageName: "@kevins8/hello",
        repository: "kevinslin/openclaw",
        rootDir,
      }),
    ).toEqual({
      packageName: "@kevins8/hello",
      repository: "kevinslin/openclaw",
      repositoryUrl: "git+https://github.com/kevinslin/openclaw.git",
      version: "2026.7.1-beta.1",
    });

    const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
    const shrinkwrap = JSON.parse(readFileSync(path.join(rootDir, "npm-shrinkwrap.json"), "utf8"));
    expect(packageJson).toMatchObject({
      name: "@kevins8/hello",
      homepage: "https://github.com/kevinslin/openclaw#readme",
      bugs: { url: "https://github.com/kevinslin/openclaw/issues" },
      repository: { type: "git", url: "git+https://github.com/kevinslin/openclaw.git" },
      publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
    });
    expect(shrinkwrap.name).toBe("@kevins8/hello");
    expect(shrinkwrap.packages[""]?.name).toBe("@kevins8/hello");
  });

  it("rejects unscoped targets and invalid GitHub repository names", () => {
    expect(() => validateForkNpmPackageTarget("openclaw-fork", "kevinslin/openclaw")).toThrow(
      "fork npm package name must be a lowercase scoped package",
    );
    expect(() => validateForkNpmPackageTarget("@kevins8/hello", "openclaw")).toThrow(
      "GitHub repository must use owner/name syntax",
    );
  });

  it("fails closed when the source package identity is not OpenClaw", () => {
    const rootDir = makePackageRoot();
    const packageJsonPath = path.join(rootDir, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    packageJson.name = "other";
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    expect(() =>
      retargetOpenClawNpmPackage({
        packageName: "@kevins8/hello",
        repository: "kevinslin/openclaw",
        rootDir,
      }),
    ).toThrow("package.json must start as openclaw");
  });
});
