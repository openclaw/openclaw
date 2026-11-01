import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { resolveNpmJsonEntries } from "../scripts/lib/npm-json-output.mts";
import { withAugmentedPluginNpmManifestForPackage } from "../scripts/lib/plugin-npm-package-manifest.mts";
import { resolveNpmRunner } from "../scripts/npm-runner.mts";
import { inspectPackageTarballBytes } from "../scripts/plugin-publication-artifact.mjs";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { writeJsonFile } from "./helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture({
  version = "2026.9.4",
  categories = ["tools", "web"],
  metadataCategories = ["web"],
} = {}) {
  const repoRoot = tempDirs.make("openclaw-clawhub-metadata-");
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
  const setMetadata = (value: Record<string, unknown>, name = "@openclaw/demo") => {
    writeJsonFile(join(clawhubMetadataDir, "package.json"), { name, version: "2026.9.3" });
    writeJsonFile(join(clawhubMetadataDir, "openclaw.plugin.json"), { id: "demo", ...value });
  };
  setMetadata({
    ...manifest,
    categories: metadataCategories,
    description: "Tooling description must not ship",
  });
  const manifestPath = join(packageDir, "openclaw.plugin.json");
  const original = readFileSync(manifestPath, "utf8");
  const expectUnchanged = () => expect(readFileSync(manifestPath, "utf8")).toBe(original);
  const expectCleaned = (staged: string) => {
    expect(staged).not.toBe(packageDir);
    expect(existsSync(staged)).toBe(false);
    expectUnchanged();
  };
  return {
    repoRoot,
    packageDir,
    clawhubMetadataDir,
    setMetadata,
    manifest,
    expectUnchanged,
    expectCleaned,
  };
}

function pack(packageDir: string, destination: string) {
  const invocation = resolveNpmRunner({
    npmArgs: ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
  });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: packageDir,
    encoding: "utf8",
    env: invocation.env,
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  expect(result.status, result.stderr).toBe(0);
  const [packed] = resolveNpmJsonEntries(JSON.parse(result.stdout));
  if (!isRecord(packed) || typeof packed.filename !== "string") {
    throw new Error("npm pack returned no artifact");
  }
  return inspectPackageTarballBytes(readFileSync(join(destination, packed.filename)));
}

it.each([
  ["2026.9.4", ["tools", "web"], "web", "web"],
  ["2026.9.4", ["runtime", "tools", "web"], "agent-runtimes", "runtime"],
  ["2026.9.3", ["agent-runtimes"], "agent-runtimes", "agent-runtimes"],
  ["2026.9.5", ["agent-runtimes"], "agent-runtimes", "agent-runtimes"],
] satisfies Array<[string, string[], string, string]>)(
  "packs %s without changing npm bytes",
  (version, categories, metadataCategory, expectedCategory) => {
    const input = fixture({ version, categories, metadataCategories: [metadataCategory] });
    const npm = withAugmentedPluginNpmManifestForPackage(
      { repoRoot: input.repoRoot, packageDir: input.packageDir },
      ({ packageDir }) => pack(packageDir, input.repoRoot),
    );
    let staged = "";
    const clawhub = withAugmentedPluginNpmManifestForPackage(input, ({ packageDir }) => {
      staged = packageDir;
      input.expectUnchanged();
      return pack(packageDir, input.repoRoot);
    });
    expect(clawhub.pluginManifest).toEqual({
      ...input.manifest,
      categories: [expectedCategory],
    });
    expect(npm.pluginManifest).toEqual(input.manifest);
    expect(clawhub.packageManifest).toEqual(npm.packageManifest);
    const nonManifest = (entry: { path: string }) => entry.path !== "package/openclaw.plugin.json";
    expect(clawhub.inventory.filter(nonManifest)).toEqual(npm.inventory.filter(nonManifest));
    input.expectCleaned(staged);
  },
);

it.each<[string, { id?: string; categories?: string[] }, string?, string?]>([
  ["plugin ID", { id: "another-plugin" }, "match the candidate"],
  ["package name", {}, "match the candidate", "@openclaw/another-plugin"],
  ["multiple categories", { categories: ["tools", "web"] }],
  ["missing category", { categories: undefined }],
  ["unsupported category", { categories: ["unknown-category"] }],
  [
    "2026.9.4 runtime without its source declaration",
    { categories: ["agent-runtimes"] },
    "requires the candidate to declare runtime",
  ],
])(
  "rejects %s before invoking the packer",
  (_label, manifest, error = "exactly one supported", packageName = "@openclaw/demo") => {
    const input = fixture();
    input.setMetadata({ categories: ["web"], ...manifest }, packageName);
    const packer = vi.fn();
    expect(() => withAugmentedPluginNpmManifestForPackage(input, packer)).toThrow(error);
    expect(packer).not.toHaveBeenCalled();
    input.expectUnchanged();
  },
);

it("accepts the shared runtime category and removes isolated staging after pack failure", () => {
  const input = fixture();
  input.setMetadata({ categories: ["runtime"] });
  let staged = "";
  expect(() =>
    withAugmentedPluginNpmManifestForPackage(input, ({ packageDir, manifest }) => {
      staged = packageDir;
      expect(manifest?.categories).toEqual(["runtime"]);
      input.expectUnchanged();
      throw new Error("pack failed");
    }),
  ).toThrow("pack failed");
  input.expectCleaned(staged);
});
