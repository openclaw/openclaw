// Plugin NPM Publish tests cover publish wrapper argument safety.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = "scripts/plugin-npm-publish.sh";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function runPluginPublishWrapper(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function makePackage(version: string): { packageDir: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "openclaw-plugin-publish-test-"));
  tempDirs.push(root);
  const packageDir = join(root, "plugin");
  const binDir = join(root, "bin");
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "@openclaw/demo", version }),
  );
  const npmPath = join(binDir, "npm");
  writeFileSync(
    npmPath,
    [
      "#!/bin/sh",
      'if [ "${1:-}" = "view" ]; then exit 1; fi',
      'if [ -n "${NPM_ARGS_FILE:-}" ]; then printf "%s\\n" "$@" > "$NPM_ARGS_FILE"; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(npmPath, 0o755);
  return { packageDir, path: `${binDir}${delimiter}${process.env.PATH ?? ""}` };
}

describe("plugin npm publish wrapper", () => {
  it("prints help before package or npm checks", () => {
    const result = runPluginPublishWrapper(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "usage: bash scripts/plugin-npm-publish.sh [--dry-run|--pack|--pack-dry-run|--publish] <package-dir> [verified-package.tgz]",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects missing mode before package checks", () => {
    const result = runPluginPublishWrapper([]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      "usage: bash scripts/plugin-npm-publish.sh [--dry-run|--pack|--pack-dry-run|--publish] <package-dir> [verified-package.tgz]",
    );
  });

  it("requires an explicit artifact directory for real pack mode", () => {
    const result = runPluginPublishWrapper(["--pack", "extensions/telegram"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--pack requires OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR");
  });

  it("rejects option-like package dirs before package checks", () => {
    const result = runPluginPublishWrapper(["--dry-run", "--wat"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("unexpected plugin npm package-dir option: --wat");
  });

  it("rejects extra arguments before package checks", () => {
    const result = runPluginPublishWrapper(["--dry-run", "extensions/telegram", "extra"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("unexpected plugin npm publish argument: extra");
  });

  it("uses the extended-stable plan without latest or beta mirrors", () => {
    const fixture = makePackage("2026.7.33");
    const result = runPluginPublishWrapper(["--dry-run", fixture.packageDir], {
      OPENCLAW_PLUGIN_NPM_PUBLISH_TAG: "extended-stable",
      PATH: fixture.path,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Resolved publish tag: extended-stable");
    expect(result.stdout).toContain("Resolved mirror dist-tags: <none>");
    expect(result.stdout).toContain("npm publish --access public --tag extended-stable");
  });

  it("publishes the verified tarball without rebuilding or repacking the package", () => {
    const fixture = makePackage("2026.7.33");
    const stagingDir = join(fixture.packageDir, "..", "staging");
    const packedDir = join(stagingDir, "package");
    const tarballPath = join(fixture.packageDir, "..", "openclaw-demo-2026.7.33.tgz");
    const npmArgsPath = join(fixture.packageDir, "..", "npm-args.txt");
    mkdirSync(packedDir, { recursive: true });
    writeFileSync(
      join(packedDir, "package.json"),
      JSON.stringify({ name: "@openclaw/demo", version: "2026.7.33" }),
    );
    execFileSync("tar", ["-czf", tarballPath, "-C", stagingDir, "package"]);

    const result = runPluginPublishWrapper(["--publish", fixture.packageDir, tarballPath], {
      NPM_ARGS_FILE: npmArgsPath,
      OPENCLAW_NPM_PUBLISH_AUTH_MODE: "trusted-publisher",
      OPENCLAW_PLUGIN_NPM_PUBLISH_TAG: "extended-stable",
      PATH: fixture.path,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Resolved verified publish target: ${tarballPath}`);
    expect(result.stdout).not.toContain("Package-local runtime build:");
    expect(readFileSync(npmArgsPath, "utf8").trim().split("\n")).toEqual([
      "publish",
      tarballPath,
      "--access",
      "public",
      "--tag",
      "extended-stable",
      "--provenance",
    ]);
  });

  it("defers stable mirrors during trusted publication without requiring a token", () => {
    const fixture = makePackage("2026.7.1");
    const stagingDir = join(fixture.packageDir, "..", "stable-staging");
    const packedDir = join(stagingDir, "package");
    const tarballPath = join(fixture.packageDir, "..", "openclaw-demo-2026.7.1.tgz");
    const npmArgsPath = join(fixture.packageDir, "..", "stable-npm-args.txt");
    mkdirSync(packedDir, { recursive: true });
    writeFileSync(
      join(packedDir, "package.json"),
      JSON.stringify({ name: "@openclaw/demo", version: "2026.7.1" }),
    );
    execFileSync("tar", ["-czf", tarballPath, "-C", stagingDir, "package"]);

    const result = runPluginPublishWrapper(["--publish", fixture.packageDir, tarballPath], {
      NPM_ARGS_FILE: npmArgsPath,
      OPENCLAW_NPM_PUBLISH_AUTH_MODE: "trusted-publisher",
      OPENCLAW_PLUGIN_NPM_DEFER_DIST_TAG_MIRRORS: "1",
      PATH: fixture.path,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Resolved mirror dist-tags: beta");
    expect(result.stdout).toContain(
      "Mirror dist-tag execution: deferred to credential-isolated release tooling",
    );
    expect(readFileSync(npmArgsPath, "utf8").trim().split("\n")).toEqual([
      "publish",
      tarballPath,
      "--access",
      "public",
      "--tag",
      "latest",
      "--provenance",
    ]);
  });

  it("rejects a verified tarball whose package identity differs from the source target", () => {
    const fixture = makePackage("2026.7.33");
    const stagingDir = join(fixture.packageDir, "..", "mismatch-staging");
    const packedDir = join(stagingDir, "package");
    const tarballPath = join(fixture.packageDir, "..", "mismatch.tgz");
    mkdirSync(packedDir, { recursive: true });
    writeFileSync(
      join(packedDir, "package.json"),
      JSON.stringify({ name: "@openclaw/demo", version: "2026.7.34" }),
    );
    execFileSync("tar", ["-czf", tarballPath, "-C", stagingDir, "package"]);

    const result = runPluginPublishWrapper(["--publish", fixture.packageDir, tarballPath], {
      PATH: fixture.path,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "verified plugin npm tarball identity mismatch: expected @openclaw/demo@2026.7.33, got @openclaw/demo@2026.7.34",
    );
  });

  it("rejects extended-stable versions below patch 33", () => {
    const fixture = makePackage("2026.7.32");
    const result = runPluginPublishWrapper(["--dry-run", fixture.packageDir], {
      OPENCLAW_PLUGIN_NPM_PUBLISH_TAG: "extended-stable",
      PATH: fixture.path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PATCH >= 33");
  });
});
