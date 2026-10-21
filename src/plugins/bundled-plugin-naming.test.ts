import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../test-utils/repo-files.js";
import type { PackageManifest, PluginManifest } from "./manifest.js";

type BundledPluginRecord = {
  dirName: string;
  packageName: string;
  manifestId: string;
  installNpmSpec?: string;
  channelId?: string;
};

const EXTENSIONS_ROOT = path.resolve(process.cwd(), "extensions");
const DIR_ID_EXCEPTIONS = new Map<string, string>([
  // Historical directory name kept until a wider repo cleanup is worth the churn.
  ["kimi-coding", "kimi"],
]);
const NON_PACKAGED_BUNDLED_PLUGIN_DIRS = new Set(["qa-channel", "qa-lab"]);
const ALLOWED_PACKAGE_SUFFIXES = [
  "",
  "-provider",
  "-plugin",
  "-speech",
  "-sandbox",
  "-media-understanding",
] as const;

function listBundledPluginDirs(): string[] {
  const files =
    listGitTrackedFiles({
      pathspecs: ["extensions/*/package.json", "extensions/*/openclaw.plugin.json"],
    }) ?? listFindPluginMetadataFiles();
  if (!files) {
    return fs.readdirSync(EXTENSIONS_ROOT).toSorted();
  }
  const metadata = new Set(files);
  return [...metadata]
    .flatMap((file) => {
      const dir = /^extensions\/([^/]+)\/package\.json$/u.exec(file)?.[1];
      return dir && metadata.has(`extensions/${dir}/openclaw.plugin.json`) ? [dir] : [];
    })
    .toSorted();
}

function listFindPluginMetadataFiles(): string[] | null {
  const result = spawnSync(
    "find",
    [
      EXTENSIONS_ROOT,
      "-maxdepth",
      "2",
      "-type",
      "f",
      "(",
      "-name",
      "package.json",
      "-o",
      "-name",
      "openclaw.plugin.json",
      ")",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((file) => toRepoRelativePath(process.cwd(), file))
    .toSorted();
}

function readBundledPluginRecords(): BundledPluginRecord[] {
  return listBundledPluginDirs().flatMap((dirName) => {
    const rootDir = path.join(EXTENSIONS_ROOT, dirName);
    const packagePath = path.join(rootDir, "package.json");
    const manifestPath = path.join(rootDir, "openclaw.plugin.json");
    if (!fs.existsSync(packagePath) || !fs.existsSync(manifestPath)) {
      return [];
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PluginManifest;
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")) as PackageManifest;
    const manifestId = normalizeOptionalString(manifest.id);
    const packageName = normalizeOptionalString(pkg.name);
    if (!manifestId || !packageName) {
      return [];
    }

    return [
      {
        dirName,
        packageName,
        manifestId,
        installNpmSpec: normalizeOptionalString(pkg.openclaw?.install?.npmSpec),
        channelId: normalizeOptionalString(pkg.openclaw?.channel?.id),
      },
    ];
  });
}

describe("bundled plugin naming guardrails", () => {
  it("lists bundled plugin metadata without scanning extension directories in-process", () => {
    expectNoReaddirSyncDuring(() => {
      const records = readBundledPluginRecords();
      expect(records.length).toBeGreaterThan(0);
      expect(records.every((record) => record.dirName.length > 0)).toBe(true);
    });
  });

  it.each<{ name: string; valid: (record: BundledPluginRecord) => boolean }>([
    {
      name: "package names stay anchored to the plugin id with an approved suffix",
      valid: ({ packageName, manifestId }) =>
        ALLOWED_PACKAGE_SUFFIXES.some(
          (suffix) => packageName === `@openclaw/${manifestId}${suffix}`,
        ),
    },
    {
      name: "directories match the plugin id unless explicitly allowlisted",
      valid: ({ dirName, manifestId }) =>
        (DIR_ID_EXCEPTIONS.get(dirName) ?? dirName) === manifestId,
    },
    {
      name: "install npm specs match the package name",
      valid: ({ installNpmSpec, packageName }) =>
        typeof installNpmSpec !== "string" || installNpmSpec === packageName,
    },
    {
      name: "non-packaged plugins do not advertise npm installs",
      valid: ({ dirName, installNpmSpec }) =>
        !NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(dirName) || typeof installNpmSpec !== "string",
    },
    {
      name: "channel ids match the canonical plugin id",
      valid: ({ channelId, manifestId }) =>
        typeof channelId !== "string" || channelId === manifestId,
    },
  ])("$name", ({ valid }) => {
    expect(readBundledPluginRecords().filter((record) => !valid(record))).toStrictEqual([]);
  });
});
