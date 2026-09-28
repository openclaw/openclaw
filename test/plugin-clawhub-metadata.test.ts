import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolvePluginNpmCommand,
  withAugmentedPluginNpmManifestForPackage,
} from "../scripts/lib/plugin-npm-package-manifest.mts";
import { inspectPackageTarballBytes } from "../scripts/plugin-publication-artifact.mjs";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";
import { writeJsonFile } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];
afterEach(() => cleanupTempDirs(tempDirs));

function fixture({
  version = "2026.9.4",
  categories = ["tools", "web"],
  metadataCategories = ["web"],
} = {}) {
  const repoRoot = makeTempDir(tempDirs, "openclaw-clawhub-metadata-");
  const packageDir = join(repoRoot, "extensions", "demo");
  const clawhubMetadataDir = join(repoRoot, "tooling", "extensions", "demo");
  const manifest = {
    id: "demo",
    categories,
    description: "Frozen candidate description",
    configSchema: { type: "object", properties: {} },
  };
  const packageJson = {
    name: "@openclaw/demo",
    version,
    files: ["index.js", "openclaw.plugin.json"],
  };
  writeJsonFile(join(packageDir, "openclaw.plugin.json"), manifest);
  writeJsonFile(join(packageDir, "package.json"), packageJson);
  writeFileSync(join(packageDir, "index.js"), "module.exports = 'frozen runtime';\n");
  writeJsonFile(join(clawhubMetadataDir, "package.json"), {
    ...packageJson,
    version: "2026.9.3",
  });
  writeJsonFile(join(clawhubMetadataDir, "openclaw.plugin.json"), {
    ...manifest,
    categories: metadataCategories,
    description: "Tooling description must not ship",
  });
  return { repoRoot, packageDir, clawhubMetadataDir, manifest };
}

function pack(packageDir: string, destination: string) {
  const invocation = resolvePluginNpmCommand([
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    destination,
  ]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: packageDir,
    encoding: "utf8",
    env: invocation.env,
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  expect(result.status, result.stderr).toBe(0);
  const [packed] = JSON.parse(result.stdout) as Array<{ filename: string }>;
  if (!packed) {
    throw new Error("npm pack returned no artifact");
  }
  return inspectPackageTarballBytes(readFileSync(join(destination, packed.filename)));
}

describe("ClawHub package category projection", () => {
  it.each([
    {
      version: "2026.9.4",
      categories: ["tools", "web"],
      metadataCategories: ["web"],
      expectedCategory: "web",
    },
    {
      version: "2026.9.4",
      categories: ["runtime", "tools", "web"],
      metadataCategories: ["agent-runtimes"],
      expectedCategory: "runtime",
    },
    ...["2026.9.3", "2026.9.5"].map((version) => ({
      version,
      categories: ["agent-runtimes"],
      metadataCategories: ["agent-runtimes"],
      expectedCategory: "agent-runtimes",
    })),
  ])("packs $expectedCategory for $version without changing npm bytes", (scenario) => {
    const input = fixture(scenario);
    const original = readFileSync(join(input.packageDir, "openclaw.plugin.json"), "utf8");
    const npm = withAugmentedPluginNpmManifestForPackage(
      { repoRoot: input.repoRoot, packageDir: input.packageDir },
      ({ packageDir }) => pack(packageDir, input.repoRoot),
    );
    let staged = "";
    const clawhub = withAugmentedPluginNpmManifestForPackage(input, ({ packageDir }) => {
      staged = packageDir;
      expect(readFileSync(join(input.packageDir, "openclaw.plugin.json"), "utf8")).toBe(original);
      return pack(packageDir, input.repoRoot);
    });
    expect(clawhub.pluginManifest).toEqual({
      ...input.manifest,
      categories: [scenario.expectedCategory],
    });
    expect(npm.pluginManifest).toEqual(input.manifest);
    expect(clawhub.packageManifest).toEqual(npm.packageManifest);
    const nonManifest = (entry: { path: string }) => entry.path !== "package/openclaw.plugin.json";
    expect(clawhub.inventory.filter(nonManifest)).toEqual(npm.inventory.filter(nonManifest));
    expect(staged).not.toBe(input.packageDir);
    expect(existsSync(staged)).toBe(false);
    expect(readFileSync(join(input.packageDir, "openclaw.plugin.json"), "utf8")).toBe(original);
  });

  it.each([
    {
      label: "plugin ID",
      manifest: { id: "another-plugin", categories: ["web"] },
      packageName: "@openclaw/demo",
      error: "match the candidate",
    },
    {
      label: "package name",
      manifest: { id: "demo", categories: ["web"] },
      packageName: "@openclaw/another-plugin",
      error: "match the candidate",
    },
    {
      label: "multiple categories",
      manifest: { id: "demo", categories: ["tools", "web"] },
      packageName: "@openclaw/demo",
      error: "exactly one supported",
    },
    {
      label: "missing category",
      manifest: { id: "demo" },
      packageName: "@openclaw/demo",
      error: "exactly one supported",
    },
    {
      label: "unsupported category",
      manifest: { id: "demo", categories: ["unknown-category"] },
      packageName: "@openclaw/demo",
      error: "exactly one supported",
    },
    {
      label: "2026.9.4 runtime without its source declaration",
      manifest: { id: "demo", categories: ["agent-runtimes"] },
      packageName: "@openclaw/demo",
      error: "requires the candidate to declare runtime",
    },
  ])("rejects $label before invoking the packer", ({ manifest, packageName, error }) => {
    const input = fixture();
    const original = readFileSync(join(input.packageDir, "openclaw.plugin.json"), "utf8");
    writeJsonFile(join(input.clawhubMetadataDir, "openclaw.plugin.json"), manifest);
    writeJsonFile(join(input.clawhubMetadataDir, "package.json"), { name: packageName });
    let called = false;
    expect(() =>
      withAugmentedPluginNpmManifestForPackage(input, () => {
        called = true;
      }),
    ).toThrow(error);
    expect(called).toBe(false);
    expect(readFileSync(join(input.packageDir, "openclaw.plugin.json"), "utf8")).toBe(original);
  });

  it("accepts the shared runtime category and removes isolated staging after pack failure", () => {
    const input = fixture();
    const original = readFileSync(join(input.packageDir, "openclaw.plugin.json"), "utf8");
    writeJsonFile(join(input.clawhubMetadataDir, "openclaw.plugin.json"), {
      id: "demo",
      categories: ["runtime"],
    });
    let staged = "";
    expect(() =>
      withAugmentedPluginNpmManifestForPackage(input, ({ packageDir, manifest }) => {
        staged = packageDir;
        expect(manifest?.categories).toEqual(["runtime"]);
        expect(readFileSync(join(input.packageDir, "openclaw.plugin.json"), "utf8")).toBe(original);
        throw new Error("pack failed");
      }),
    ).toThrow("pack failed");
    expect(staged).not.toBe(input.packageDir);
    expect(existsSync(staged)).toBe(false);
    expect(readFileSync(join(input.packageDir, "openclaw.plugin.json"), "utf8")).toBe(original);
  });
});
