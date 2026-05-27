import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseArgs,
  readArtifactPackageCandidateMetadata,
  readPackageBuildSourceSha,
  resolveNpmPackInvocation,
  validateOpenClawPackageSpec,
} from "../../scripts/resolve-openclaw-package-candidate.mjs";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolve-openclaw-package-candidate", () => {
  it("accepts only OpenClaw release package specs for npm candidates", () => {
    for (const spec of [
      "openclaw@beta",
      "openclaw@alpha",
      "openclaw@latest",
      "openclaw@2026.4.27",
      "openclaw@2026.4.27-1",
      "openclaw@2026.4.27-beta.2",
      "openclaw@2026.4.27-alpha.2",
    ]) {
      expect(validateOpenClawPackageSpec(spec), spec).toBeUndefined();
    }

    expect(() => validateOpenClawPackageSpec("@evil/openclaw@1.0.0")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@canary")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@2026.04.27")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@npm:other-package")).toThrow(
      "package_spec must be openclaw@alpha",
    );
    expect(() => validateOpenClawPackageSpec("openclaw@file:../other-package.tgz")).toThrow(
      "package_spec must be openclaw@alpha",
    );
  });

  it("parses optional empty workflow inputs without rejecting the command line", () => {
    expect(
      parseArgs([
        "--source",
        "npm",
        "--package-ref",
        "release/2026.4.27",
        "--package-spec",
        "openclaw@beta",
        "--package-url",
        "",
        "--package-sha256",
        "",
        "--artifact-dir",
        ".",
        "--output-dir",
        ".artifacts/docker-e2e-package",
      ]),
    ).toEqual({
      artifactDir: ".",
      githubOutput: "",
      metadata: "",
      outputDir: ".artifacts/docker-e2e-package",
      outputName: "openclaw-current.tgz",
      packageSha256: "",
      packageRef: "release/2026.4.27",
      packageSpec: "openclaw@beta",
      packageUrl: "",
      source: "npm",
    });
  });

  it("reads package source metadata from package artifacts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-candidate-"));
    tempDirs.push(dir);
    await writeFile(
      path.join(dir, "package-candidate.json"),
      JSON.stringify(
        {
          packageRef: "release/2026.4.30",
          packageSourceSha: "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2",
          packageTrustedReason: "repository-branch-history",
          sha256: "a".repeat(64),
        },
        null,
        2,
      ),
    );

    await expect(readArtifactPackageCandidateMetadata(dir)).resolves.toEqual({
      packageRef: "release/2026.4.30",
      packageSourceSha: "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2",
      packageTrustedReason: "repository-branch-history",
      sha256: "a".repeat(64),
    });
  });

  it("reads the source SHA from packed npm build metadata", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-build-info-"));
    tempDirs.push(dir);
    const root = path.join(dir, "package");
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
    await writeFile(
      path.join(root, "dist", "build-info.json"),
      JSON.stringify({ commit: "66CE632B9B7C5C7FDD3E66C739687D51638AD6E2" }),
    );
    const tarball = path.join(dir, "openclaw.tgz");
    await new Promise<void>((resolve, reject) => {
      execFile("tar", ["-czf", tarball, "-C", dir, "package"], (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    await expect(readPackageBuildSourceSha(tarball)).resolves.toBe(
      "66ce632b9b7c5c7fdd3e66c739687d51638ad6e2",
    );
  });
});

describe("resolveNpmPackInvocation", () => {
  const packArgsTail = (spec: string, outputDir: string) => [
    "pack",
    spec,
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    outputDir,
  ];

  it("uses the active node toolchain npm-cli.js on POSIX when present", () => {
    const execPath = "/usr/local/n/versions/node/24.13.0/bin/node";
    const expectedNpmCliPath = path.posix.resolve(
      path.posix.dirname(execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    );

    const invocation = resolveNpmPackInvocation({
      packageSpec: "openclaw@beta",
      outputDir: "/tmp/out",
      execPath,
      env: {},
      existsSync: (candidate: string) => candidate === expectedNpmCliPath,
      platform: "darwin",
    });

    expect(invocation).toEqual({
      command: execPath,
      args: [expectedNpmCliPath, ...packArgsTail("openclaw@beta", "/tmp/out")],
      options: { capture: true },
    });
  });

  it("routes through cmd.exe when only npm.cmd is present next to node on Windows (issue #87233)", () => {
    // This is the RED-first case: before the fix, bare spawn("npm", ...) on Windows
    // would fail with ENOENT because PATHEXT is not consulted. resolveNpmRunner wraps
    // the .cmd shim via cmd.exe with windowsVerbatimArguments.
    const execPath = "C:\\nodejs\\node.exe";
    const npmCmdPath = path.win32.resolve(path.win32.dirname(execPath), "npm.cmd");

    const invocation = resolveNpmPackInvocation({
      packageSpec: "openclaw@latest",
      outputDir: "C:\\out",
      execPath,
      env: {},
      existsSync: (candidate: string) => candidate === npmCmdPath,
      comSpec: "C:\\Windows\\System32\\cmd.exe",
      platform: "win32",
    });

    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args[0]).toBe("/d");
    expect(invocation.args[1]).toBe("/s");
    expect(invocation.args[2]).toBe("/c");
    expect(invocation.args[3]).toContain(npmCmdPath);
    expect(invocation.args[3]).toContain("pack");
    expect(invocation.args[3]).toContain("openclaw@latest");
    expect(invocation.options).toEqual({
      capture: true,
      windowsVerbatimArguments: true,
    });
  });

  it("uses an adjacent npm.exe on Windows without a cmd.exe wrapper", () => {
    const execPath = "C:\\nodejs\\node.exe";
    const npmExePath = path.win32.resolve(path.win32.dirname(execPath), "npm.exe");

    const invocation = resolveNpmPackInvocation({
      packageSpec: "openclaw@alpha",
      outputDir: "C:\\out",
      execPath,
      env: {},
      existsSync: (candidate: string) => candidate === npmExePath,
      platform: "win32",
    });

    expect(invocation).toEqual({
      command: npmExePath,
      args: packArgsTail("openclaw@alpha", "C:\\out"),
      options: { capture: true },
    });
  });

  it("falls back to bare npm on POSIX, prefixing PATH with the node dir", () => {
    const invocation = resolveNpmPackInvocation({
      packageSpec: "openclaw@beta",
      outputDir: "/tmp/out",
      execPath: "/tmp/node",
      env: { PATH: "/usr/bin:/bin" },
      existsSync: () => false,
      platform: "linux",
    });

    expect(invocation.command).toBe("npm");
    expect(invocation.args).toEqual(packArgsTail("openclaw@beta", "/tmp/out"));
    expect(invocation.options.capture).toBe(true);
    expect(invocation.options.env).toEqual({
      PATH: `/tmp${path.delimiter}/usr/bin:/bin`,
    });
    expect(invocation.options.windowsVerbatimArguments).toBeUndefined();
  });

  it("fails closed on Windows when no toolchain-local npm can be located", () => {
    expect(() =>
      resolveNpmPackInvocation({
        packageSpec: "openclaw@beta",
        outputDir: "C:\\out",
        execPath: "C:\\nodejs\\node.exe",
        env: { Path: "C:\\Windows\\System32" },
        existsSync: () => false,
        platform: "win32",
      }),
    ).toThrow("OpenClaw refuses to shell out to bare npm on Windows");
  });
});
