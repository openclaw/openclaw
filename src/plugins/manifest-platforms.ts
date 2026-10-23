import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { PluginManifestDefaultPlatform } from "./manifest-types.js";

const MANIFEST_PLATFORMS: ReadonlySet<string> = new Set<PluginManifestDefaultPlatform>([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
  "netbsd",
]);

export function normalizeManifestPlatforms(value: unknown): PluginManifestDefaultPlatform[] {
  return normalizeTrimmedStringList(value).filter(
    (platform): platform is PluginManifestDefaultPlatform => MANIFEST_PLATFORMS.has(platform),
  );
}
