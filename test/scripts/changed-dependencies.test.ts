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
    [
      "transitive version",
      (source: string) =>
        source
          .replaceAll("leaf@1.0.0", "leaf@2.0.0")
          .replaceAll("leaf: 1.0.0", "leaf: 2.0.0")
          .replace(
            "leaf: {specifier: 1.0.0, version: 1.0.0}",
            "leaf: {specifier: 1.0.0, version: 2.0.0}",
          ),
    ],
    [
      "same-version integrity",
      (source: string) => source.replace("leaf-bytes", "different-leaf-bytes"),
    ],
  ])("selects only importers of a changed %s, at the workspace owner", (_label, change) => {
    write("pnpm-lock.yaml", change(lockfile));
    expect(select()).toEqual({
      importerBindings: expect.any(Array),
      importers: [
        { root: ".", dependencies: ["alpha"] },
        { root: "packages/shared", dependencies: ["leaf"] },
      ],
    });
  });

  it("keeps peer-instance changes scoped to their direct importer", () => {
    write(
      "pnpm-lock.yaml",
      lockfile.replaceAll("peer@1.0.0", "peer@2.0.0").replace("peer: 1.0.0", "peer: 2.0.0"),
    );
    expect(select()).toEqual({
      importerBindings: expect.any(Array),
      importers: [{ root: ".", dependencies: ["alpha"] }],
    });
  });

  it("does not select another workspace using an unchanged resolution of the same dependency", () => {
    write(
      "pnpm-lock.yaml",
      lockfile.replace(
        "stable: {specifier: 1.0.0, version: 1.0.0}",
        "stable: {specifier: 2.0.0, version: 2.0.0}",
      ),
    );
    expect(select()).toEqual({
      importerBindings: [
        { root: ".", dependencies: ["alpha", "shared", "stable"] },
        { root: "packages/shared", dependencies: ["leaf"] },
        { root: "ui", dependencies: ["stable"] },
      ],
      importers: [{ root: "ui", dependencies: ["stable"] }],
    });
  });

  it("retains the removed dependency name for graph consumers", () => {
    write(
      "package.json",
      JSON.stringify({ ...manifest, dependencies: { stable: "1.0.0", shared: "workspace:*" } }),
    );
    write(
      "pnpm-lock.yaml",
      lockfile.replace(
        "      alpha:\n        specifier: 1.0.0\n        version: 1.0.0(peer@1.0.0)\n",
        "",
      ),
    );
    expect(select(["package.json", "pnpm-lock.yaml"])).toEqual({
      importerBindings: expect.any(Array),
      importers: [{ root: ".", dependencies: ["alpha"] }],
    });
  });

  it("ignores metadata and specifier changes with the same resolved dependency", () => {
    write(
      "package.json",
      JSON.stringify({
        ...manifest,
        description: "Updated metadata",
        dependencies: { ...manifest.dependencies, alpha: "^1.0.0" },
      }),
    );
    write(
      "pnpm-lock.yaml",
      lockfile.replace("alpha:\n        specifier: 1.0.0", "alpha:\n        specifier: ^1.0.0"),
    );
    expect(select(["package.json", "pnpm-lock.yaml"])).toEqual({
      importerBindings: expect.any(Array),
      importers: [],
    });
  });

  it.each([
    [
      "root manifest plugin settings",
      () => write("package.json", JSON.stringify({ ...manifest, openclaw: {} })),
      "execution or resolution",
    ],
    [
      "manifest execution",
      () =>
        write(
          "package.json",
          JSON.stringify({ ...manifest, scripts: { test: "different-runner" } }),
        ),
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
  ])("fails closed for %s", (_label, change, reason) => {
    change();
    expect(select(["package.json", "pnpm-lock.yaml"])).toEqual({
      importers: [],
      globalReason: expect.stringContaining(reason),
    });
  });

  it("fails closed for workspace installation metadata outside dependency edges", () => {
    write(
      "pnpm-lock.yaml",
      lockfile.replace(
        "  .:\n",
        "  .:\n    dependenciesMeta:\n      alpha:\n        injected: true\n",
      ),
    );
    expect(select()).toEqual({
      importers: [],
      globalReason: "workspace installation metadata changed: .",
    });
  });

  it("keeps shared test-runner resolution changes global", () => {
    write("pnpm-lock.yaml", lockfile.replaceAll("stable", "vitest"));
    expect(select()).toEqual({
      importers: [],
      globalReason: expect.stringContaining("shared Node test runtime changed: vitest"),
    });
  });

  it("keeps package-manager environment changes global", () => {
    write("pnpm-lock.yaml", `---\nlockfileVersion: '9.0'\nimporters: {}\n---\n${lockfile}`);
    expect(select()).toEqual({
      importers: [],
      globalReason: "pnpm package-manager environment changed",
    });
  });

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
