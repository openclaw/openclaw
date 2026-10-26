import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { expect, it } from "vitest";
import { listGitTrackedFiles } from "../test-utils/repo-files.js";
import type { PackageManifest, PluginManifest } from "./manifest.js";

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

function readBundledPluginRecords() {
  const files = listGitTrackedFiles({
    pathspecs: ["extensions/*/package.json", "extensions/*/openclaw.plugin.json"],
  });
  if (!files) {
    throw new Error("Bundled naming checks require a Git checkout");
  }
  const metadata = new Set(files);
  return [...metadata]
    .flatMap((file) => {
      const dir = /^extensions\/([^/]+)\/package\.json$/u.exec(file)?.[1];
      return dir && metadata.has(`extensions/${dir}/openclaw.plugin.json`) ? [dir] : [];
    })
    .toSorted()
    .flatMap((dirName) => {
      const rootDir = path.join(EXTENSIONS_ROOT, dirName);
      const packagePath = path.join(rootDir, "package.json");
      const manifestPath = path.join(rootDir, "openclaw.plugin.json");
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

it.each<[string, (record: ReturnType<typeof readBundledPluginRecords>[number]) => boolean]>([
  [
    "package names stay anchored to the plugin id with an approved suffix",
    ({ packageName, manifestId }) =>
      ALLOWED_PACKAGE_SUFFIXES.some((suffix) => packageName === `@openclaw/${manifestId}${suffix}`),
  ],
  [
    "directories match the plugin id unless explicitly allowlisted",
    ({ dirName, manifestId }) => (DIR_ID_EXCEPTIONS.get(dirName) ?? dirName) === manifestId,
  ],
  [
    "install npm specs match the package name",
    ({ installNpmSpec, packageName }) =>
      typeof installNpmSpec !== "string" || installNpmSpec === packageName,
  ],
  [
    "non-packaged plugins do not advertise npm installs",
    ({ dirName, installNpmSpec }) =>
      !NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(dirName) || typeof installNpmSpec !== "string",
  ],
  [
    "channel ids match the canonical plugin id",
    ({ channelId, manifestId }) => typeof channelId !== "string" || channelId === manifestId,
  ],
])("%s", (_name, valid) => {
  const records = readBundledPluginRecords();
  expect(records.length).toBeGreaterThan(0);
  expect(records.filter((record) => !valid(record))).toStrictEqual([]);
});
