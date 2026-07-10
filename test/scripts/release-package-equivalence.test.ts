import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { compareReleasePackageArtifacts } from "../../scripts/lib/release-package-equivalence.mjs";
import { extractCurrentPackageChangelog } from "../../scripts/package-changelog.mjs";

const SOURCE_SHA = "1111111111111111111111111111111111111111";
const TARGET_SHA = "2222222222222222222222222222222222222222";
const VERSION = "2026.7.1-beta.3";
const TRUSTED_DOCS = [
  "docs/ci.md",
  "docs/reference/RELEASING.md",
  "docs/reference/full-release-validation.md",
] as const;
const roots: string[] = [];
const createTar = (args: string[]) =>
  execFileSync("tar", args, { env: { ...process.env, COPYFILE_DISABLE: "1" } });

function rawChangelog(side: "source" | "target") {
  return `# Changelog

Docs: https://docs.openclaw.ai

## 2026.7.1

### Fixes

- ${side} release notes contain enough detail to satisfy the package changelog safety check.

## 2026.6.11

### Fixes

- Previously shipped release notes stay in the repository but not in the package.
`;
}

function write(root: string, relativePath: string, content: string, executable = false) {
  const filePath = path.join(root, "package", relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  if (executable) chmodSync(filePath, 0o755);
}

function createPackage(
  root: string,
  side: "source" | "target",
  overrides: Record<string, string> = {},
) {
  const isSource = side === "source";
  const sha = isSource ? SOURCE_SHA : TARGET_SHA;
  const asset = isSource ? "index-AAAAAAAA.js" : "index-CCCCCCCC.js";
  const chunk = isSource ? "chunk-BBBBBBBB.js" : "chunk-DDDDDDDD.js";
  const builtAt = isSource ? "2026-07-10T01:02:03.000Z" : "2026-07-10T02:03:04.000Z";
  const changelog = rawChangelog(side);
  const files: Record<string, string> = {
    "CHANGELOG.md": extractCurrentPackageChangelog(changelog, VERSION),
    "README.md": "same product\n",
    "openclaw.mjs": "#!/usr/bin/env node\n",
    "package.json": JSON.stringify({ name: "openclaw", version: VERSION }),
    "docs/ci.md": "trusted ci docs\n",
    "docs/reference/RELEASING.md": "trusted release docs\n",
    "docs/reference/full-release-validation.md": "trusted validation docs\n",
    "dist/build-info.json": JSON.stringify({
      version: VERSION,
      commit: sha,
      builtAt,
    }),
    "dist/cli-startup-metadata.json": JSON.stringify({
      generatorSignature: "same",
      rootHelpText: `OpenClaw 2026.7.1-beta.3 (${sha.slice(0, 7)})\n`,
      subcommandHelpText: {
        doctor: `OpenClaw 2026.7.1-beta.3 (${sha.slice(0, 7)}) doctor\n`,
      },
    }),
    "dist/plugin-sdk/.boundary-entry-shims.stamp": `${builtAt}\n`,
    "dist/control-ui/index.html": `<script src="./assets/${asset}"></script>\n`,
    "dist/control-ui/icon.png": "same binary fixture",
    "dist/control-ui/sw.js": `const EMBEDDED_CACHE_VERSION = "2026.7.1-beta.3-${sha.slice(0, 12)}";\n`,
    [`dist/control-ui/assets/${asset}`]: `import("./${chunk}"); export const commit="${sha.slice(0, 12)}";\n`,
    [`dist/control-ui/assets/${chunk}`]: "export const value = 1;\n",
    "dist/postinstall-inventory.json": JSON.stringify([
      "README.md",
      `dist/control-ui/assets/${asset}`,
      `dist/control-ui/assets/${chunk}`,
    ]),
    "dist/plugin-sdk/sample.d.ts": isSource
      ? 'export type T = "b" | "a";\nexport type O = { b: string; a: number };\n'
      : 'export type T = "a" | "b";\nexport type O = { a: number; b: string };\n',
  };
  const mergedFiles = { ...files, ...overrides };
  for (const [relativePath, content] of Object.entries(mergedFiles)) {
    write(root, relativePath, content, relativePath === "openclaw.mjs");
  }
  return mergedFiles;
}

function fixture(
  overrides: { source?: Record<string, string>; target?: Record<string, string> } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-package-equivalence-test-"));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  mkdirSync(sourceRoot);
  mkdirSync(targetRoot);
  const sourceFiles = createPackage(sourceRoot, "source", overrides.source);
  const targetFiles = createPackage(targetRoot, "target", overrides.target);
  const sourceTarball = path.join(root, "source.tgz");
  const targetTarball = path.join(root, "target.tgz");
  createTar(["-czf", sourceTarball, "-C", sourceRoot, "package"]);
  createTar(["-czf", targetTarball, "-C", targetRoot, "package"]);
  return {
    sourceTarball,
    targetTarball,
    sourceChangelog: rawChangelog("source"),
    targetChangelog: rawChangelog("target"),
    targetPackage: path.join(targetRoot, "package"),
    trustedFiles: TRUSTED_DOCS.map((filePath) => ({
      path: filePath,
      source: sourceFiles[filePath],
      target: targetFiles[filePath],
    })),
  };
}

function compare(files: ReturnType<typeof fixture>) {
  return compareReleasePackageArtifacts({
    ...files,
    sourceSha: SOURCE_SHA,
    targetSha: TARGET_SHA,
    expectedVersion: VERSION,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("compareReleasePackageArtifacts", () => {
  it("accepts only bounded rebuild and trusted git-file differences", async () => {
    const files = fixture({
      target: { "docs/ci.md": "updated trusted ci docs\n" },
    });
    const result = await compare(files);

    expect(result.raw.equal).toBe(false);
    expect(result.canonical.equal).toBe(true);
    expect(result.canonical.sourceSha256).toBe(result.canonical.targetSha256);
    expect(result.changedPaths).toContain("CHANGELOG.md");
    expect(result.changedPaths).toContain("docs/ci.md");
    expect(result.changedPaths).toContain("dist/control-ui/assets/index-AAAAAAAA.js");
    expect(result.rules).toContain("trusted-git-file:docs/ci.md");
    expect(result.trustedFiles).toHaveLength(3);
  });

  it("rejects product changes, links, duplicate paths, and privileged modes", async () => {
    await expect(
      compare(fixture({ target: { "README.md": "changed product\n" } })),
    ).rejects.toThrow(/differ outside supported rules at README\.md/u);
    await expect(
      compare(fixture({ target: { "dist/control-ui/icon.png": "changed binary" } })),
    ).rejects.toThrow(/unsupported changed Control UI path/u);

    const linked = fixture();
    symlinkSync("README.md", path.join(linked.targetPackage, "linked-readme"));
    createTar(["-czf", linked.targetTarball, "-C", path.dirname(linked.targetPackage), "package"]);
    await expect(compare(linked)).rejects.toThrow(/link or special archive member/u);

    const duplicate = fixture();
    createTar([
      "-czf",
      duplicate.targetTarball,
      "-C",
      path.dirname(duplicate.targetPackage),
      "package",
      "package/README.md",
    ]);
    await expect(compare(duplicate)).rejects.toThrow(/duplicate archive path/u);

    const collision = fixture();
    const collisionPath = path.join(collision.targetPackage, "collision");
    const collisionTar = path.join(path.dirname(collision.targetTarball), "collision.tar");
    writeFileSync(collisionPath, "regular file");
    createTar(["-cf", collisionTar, "-C", path.dirname(collision.targetPackage), "package"]);
    rmSync(collisionPath);
    mkdirSync(collisionPath);
    createTar([
      "-rf",
      collisionTar,
      "-C",
      path.dirname(collision.targetPackage),
      "package/collision",
    ]);
    writeFileSync(collision.targetTarball, gzipSync(readFileSync(collisionTar)));
    await expect(compare(collision)).rejects.toThrow(/duplicate archive path/u);

    const privileged = fixture();
    chmodSync(path.join(privileged.targetPackage, "openclaw.mjs"), 0o4755);
    createTar([
      "-czf",
      privileged.targetTarball,
      "-C",
      path.dirname(privileged.targetPackage),
      "package",
    ]);
    await expect(compare(privileged)).rejects.toThrow(/special permission bits/u);
  });

  it("rejects untrusted changelog, trusted-file, build, and version identities", async () => {
    const files = fixture();
    files.targetChangelog = files.targetChangelog.replace(
      "target release notes",
      "untrusted release notes",
    );
    await expect(compare(files)).rejects.toThrow(/does not match trusted changelog/u);

    const mismatchedTrustedFile = fixture();
    mismatchedTrustedFile.trustedFiles[0].target = "not the packaged target\n";
    await expect(compare(mismatchedTrustedFile)).rejects.toThrow(
      /docs\/ci\.md does not match its trusted source and target git blobs/u,
    );

    const wrongBuild = fixture({
      target: {
        "dist/build-info.json": JSON.stringify({
          version: VERSION,
          commit: SOURCE_SHA,
          builtAt: "2026-07-10T02:03:04.000Z",
        }),
      },
    });
    await expect(compare(wrongBuild)).rejects.toThrow(/commit does not match/u);

    const wrongVersion = fixture({
      target: {
        "package.json": JSON.stringify({ name: "openclaw", version: "2026.7.1-beta.2" }),
      },
    });
    await expect(compare(wrongVersion)).rejects.toThrow(/openclaw@2026\.7\.1-beta\.3/u);
  });

  it("matches the captured 7ebe237 to 811ddd artifact pair when available", async () => {
    const capture = "/tmp/openclaw-delta-pack.jR2hCG";
    const sourceTarball = path.join(capture, "source", "openclaw-2026.7.1-beta.3.tgz");
    const targetTarball = path.join(capture, "target", "openclaw-2026.7.1-beta.3.tgz");
    if (!existsSync(sourceTarball) || !existsSync(targetTarball)) return;
    const sourceSha = "7ebe237b67d3d57bd027b71d4ae415f90d4d8cab";
    const targetSha = "811ddd96180583bae00001f71971419182ae0520";
    const trustedFiles = TRUSTED_DOCS.map((filePath) => ({
      path: filePath,
      source: execFileSync("git", ["show", `${sourceSha}:${filePath}`]),
      target: execFileSync("git", ["show", `${targetSha}:${filePath}`]),
    }));
    const result = await compareReleasePackageArtifacts({
      sourceTarball,
      targetTarball,
      sourceSha,
      targetSha,
      expectedVersion: VERSION,
      sourceChangelog: execFileSync("git", ["show", `${sourceSha}:CHANGELOG.md`]),
      targetChangelog: execFileSync("git", ["show", `${targetSha}:CHANGELOG.md`]),
      trustedFiles,
    });
    expect(result.raw.equal).toBe(false);
    expect(result.canonical.equal).toBe(true);
  });
});
