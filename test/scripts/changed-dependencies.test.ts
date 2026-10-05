import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveChangedDependencies } from "../../scripts/lib/changed-dependencies.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const manifest = {
  name: "fixture",
  dependencies: { alpha: "1.0.0", stable: "1.0.0", shared: "workspace:*" },
};
const pluginManifest = {
  name: "@openclaw/channel",
  openclaw: { channel: { setup: { fields: [] } } },
};
const lockfile = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
importers:
  .:
    dependencies:
      alpha:
        specifier: 1.0.0
        version: 1.0.0(peer@1.0.0)
      stable:
        specifier: 1.0.0
        version: 1.0.0
      shared:
        specifier: workspace:*
        version: link:packages/shared
  packages/shared:
    dependencies:
      leaf: {specifier: 1.0.0, version: 1.0.0}
  ui:
    dependencies:
      stable: {specifier: 1.0.0, version: 1.0.0}
packages:
  alpha@1.0.0:
    resolution: {integrity: alpha-bytes}
  leaf@1.0.0:
    resolution: {integrity: leaf-bytes}
  peer@1.0.0:
    resolution: {integrity: peer-bytes}
  stable@1.0.0:
    resolution: {integrity: stable-bytes}
  stable@2.0.0:
    resolution: {integrity: stable-new-bytes}
snapshots:
  alpha@1.0.0(peer@1.0.0):
    dependencies:
      leaf: 1.0.0
      peer: 1.0.0
  leaf@1.0.0: {}
  peer@1.0.0: {}
  stable@1.0.0: {}
  stable@2.0.0: {}
`;

describe("changed resolved dependencies", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  let cwd: string;
  let baseRef: string;
  const write = (file: string, contents: string) => writeFileSync(path.join(cwd, file), contents);
  const select = (changedPaths = ["pnpm-lock.yaml"]) =>
    resolveChangedDependencies({ cwd, baseRef, changedPaths });

  beforeAll(() => {
    cwd = tempDirs.make("changed-dependencies-");
    mkdirSync(path.join(cwd, "packages/shared"), { recursive: true });
    mkdirSync(path.join(cwd, "extensions/channel"), { recursive: true });
    write("package.json", JSON.stringify(manifest));
    write("extensions/channel/package.json", JSON.stringify(pluginManifest));
    write("pnpm-lock.yaml", lockfile);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", `core.hooksPath=${path.join(cwd, "no-hooks")}`, ...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--no-verify",
      "-m",
      "fixture",
    );
    baseRef = git("rev-parse", "HEAD");
  });
  beforeEach(() => {
    write("package.json", JSON.stringify(manifest));
    write("extensions/channel/package.json", JSON.stringify(pluginManifest));
    write("pnpm-lock.yaml", lockfile);
  });

  it("retains plugin-owned setup metadata separately from resolved dependencies", () => {
    write(
      "extensions/channel/package.json",
      JSON.stringify({
        ...pluginManifest,
        openclaw: { channel: { setup: { fields: [{ key: "appId", kind: "string" }] } } },
      }),
    );
    expect(select(["extensions/channel/package.json"])).toEqual({
      importerBindings: expect.any(Array),
      importers: [],
      pluginMetadataPaths: ["extensions/channel/package.json"],
    });
    write(
      "extensions/channel/package.json",
      JSON.stringify({ ...pluginManifest, openclaw: {}, scripts: { test: "another-runner" } }),
    );
    expect(select(["extensions/channel/package.json"])).toEqual({
      importers: [],
      globalReason: expect.stringContaining("execution or resolution"),
    });
  });

  it.each([
    {
      name: "transitive version",
      change: (source: string) =>
        source
          .replaceAll("leaf@1.0.0", "leaf@2.0.0")
          .replaceAll("leaf: 1.0.0", "leaf: 2.0.0")
          .replace(
            "leaf: {specifier: 1.0.0, version: 1.0.0}",
            "leaf: {specifier: 1.0.0, version: 2.0.0}",
          ),
      importers: [
        { root: ".", dependencies: ["alpha"] },
        { root: "packages/shared", dependencies: ["leaf"] },
      ],
    },
    {
      name: "same-version integrity",
      change: (source: string) => source.replace("leaf-bytes", "different-leaf-bytes"),
      importers: [
        { root: ".", dependencies: ["alpha"] },
        { root: "packages/shared", dependencies: ["leaf"] },
      ],
    },
    {
      name: "peer-instance change",
      change: (source: string) =>
        source.replaceAll("peer@1.0.0", "peer@2.0.0").replace("peer: 1.0.0", "peer: 2.0.0"),
      importers: [{ root: ".", dependencies: ["alpha"] }],
    },
    {
      name: "workspace-local resolution",
      change: (source: string) =>
        source.replace(
          "stable: {specifier: 1.0.0, version: 1.0.0}",
          "stable: {specifier: 2.0.0, version: 2.0.0}",
        ),
      importerBindings: [
        { root: ".", dependencies: ["alpha", "shared", "stable"] },
        { root: "packages/shared", dependencies: ["leaf"] },
        { root: "ui", dependencies: ["stable"] },
      ],
      importers: [{ root: "ui", dependencies: ["stable"] }],
    },
    {
      name: "removed dependency",
      manifest: { ...manifest, dependencies: { stable: "1.0.0", shared: "workspace:*" } },
      change: (source: string) =>
        source.replace(
          "      alpha:\n        specifier: 1.0.0\n        version: 1.0.0(peer@1.0.0)\n",
          "",
        ),
      importers: [{ root: ".", dependencies: ["alpha"] }],
    },
    {
      name: "metadata and specifier changes with unchanged resolution",
      manifest: {
        ...manifest,
        description: "Updated metadata",
        dependencies: { ...manifest.dependencies, alpha: "^1.0.0" },
      },
      change: (source: string) =>
        source.replace("alpha:\n        specifier: 1.0.0", "alpha:\n        specifier: ^1.0.0"),
      importers: [],
    },
  ])(
    "scopes $name to its resolved importers",
    ({ change, manifest: changedManifest, importers, importerBindings }) => {
      if (changedManifest) {
        write("package.json", JSON.stringify(changedManifest));
      }
      write("pnpm-lock.yaml", change(lockfile));
      expect(select(changedManifest ? ["package.json", "pnpm-lock.yaml"] : undefined)).toEqual({
        importerBindings: importerBindings ?? expect.any(Array),
        importers,
      });
    },
  );

  it.each([
    [
      "root manifest plugin settings",
      () => write("package.json", JSON.stringify({ ...manifest, openclaw: {} })),
      "execution or resolution",
    ],
    [
      "unlocked manifest",
      () =>
        write(
          "package.json",
          JSON.stringify({
            ...manifest,
            dependencies: { ...manifest.dependencies, alpha: "2.0.0" },
          }),
        ),
      "manifest and lockfile disagree",
    ],
    [
      "global install setting",
      () =>
        write(
          "pnpm-lock.yaml",
          lockfile.replace("autoInstallPeers: true", "autoInstallPeers: false"),
        ),
      "global resolution setting",
    ],
    [
      "missing snapshots",
      () => write("pnpm-lock.yaml", lockfile.replace("snapshots:", "missingSnapshots:")),
      "incomplete",
    ],
    [
      "malformed lock",
      () => write("pnpm-lock.yaml", "importers: [broken"),
      "could not be verified",
    ],
    [
      "unresolved transitive edge",
      () => write("pnpm-lock.yaml", lockfile.replace("leaf: 1.0.0", "leaf: 9.0.0")),
      "could not be verified",
    ],
    [
      "workspace installation metadata",
      () =>
        write(
          "pnpm-lock.yaml",
          lockfile.replace(
            "  .:\n",
            "  .:\n    dependenciesMeta:\n      alpha:\n        injected: true\n",
          ),
        ),
      "workspace installation metadata changed: .",
      ["pnpm-lock.yaml"],
    ],
    [
      "shared test-runner resolution",
      () => write("pnpm-lock.yaml", lockfile.replaceAll("stable", "vitest")),
      "shared Node test runtime changed: vitest",
      ["pnpm-lock.yaml"],
    ],
    [
      "package-manager environment",
      () => write("pnpm-lock.yaml", `---\nlockfileVersion: '9.0'\nimporters: {}\n---\n${lockfile}`),
      "pnpm package-manager environment changed",
      ["pnpm-lock.yaml"],
    ],
  ])(
    "fails closed for %s",
    (_label, change, reason, paths = ["package.json", "pnpm-lock.yaml"]) => {
      change();
      expect(select(paths)).toEqual({
        importers: [],
        globalReason:
          _label === "workspace installation metadata" || _label === "package-manager environment"
            ? reason
            : expect.stringContaining(reason),
      });
    },
  );

  it("fails closed when the exact base cannot be read", () => {
    expect(
      resolveChangedDependencies({
        cwd,
        baseRef: "missing-revision",
        changedPaths: ["pnpm-lock.yaml"],
      }),
    ).toEqual({ importers: [], globalReason: expect.stringContaining("could not be verified") });
  });
});
