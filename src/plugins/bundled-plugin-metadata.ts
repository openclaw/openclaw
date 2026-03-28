import fs from "node:fs";
import path from "node:path";
import { GENERATED_BUNDLED_PLUGIN_METADATA } from "./bundled-plugin-metadata.generated.js";
import type { PluginManifest, OpenClawPackageManifest } from "./manifest.js";

const PUBLIC_SURFACE_SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"] as const;

type GeneratedBundledPluginPathPair = {
  source: string;
  built: string;
};

export type GeneratedBundledPluginMetadata = {
  dirName: string;
  idHint: string;
  source: GeneratedBundledPluginPathPair;
  setupSource?: GeneratedBundledPluginPathPair;
  publicSurfaceArtifacts?: readonly string[];
  runtimeSidecarArtifacts?: readonly string[];
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  packageManifest?: OpenClawPackageManifest;
  manifest: PluginManifest;
};

export const BUNDLED_PLUGIN_METADATA =
  GENERATED_BUNDLED_PLUGIN_METADATA as unknown as readonly GeneratedBundledPluginMetadata[];

export function resolveBundledPluginGeneratedPath(
  rootDir: string,
  entry: GeneratedBundledPluginPathPair | undefined,
): string | null {
  if (!entry) {
    return null;
  }
  const candidates = [entry.built, entry.source]
    .filter(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    )
    .map((candidate) => path.resolve(rootDir, candidate));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveBundledPluginPublicSurfacePath(params: {
  rootDir: string;
  dirName: string;
  artifactBasename: string;
}): string | null {
  const artifactBasename = params.artifactBasename.replace(/^\.\//u, "");
  if (!artifactBasename) {
    return null;
  }

  const builtCandidate = path.resolve(
    params.rootDir,
    "dist",
    "extensions",
    params.dirName,
    artifactBasename,
  );
  if (fs.existsSync(builtCandidate)) {
    return builtCandidate;
  }

  const sourceBaseName = artifactBasename.replace(/\.js$/u, "");
  for (const ext of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
    const sourceCandidate = path.resolve(
      params.rootDir,
      "extensions",
      params.dirName,
      `${sourceBaseName}${ext}`,
    );
    if (fs.existsSync(sourceCandidate)) {
      return sourceCandidate;
    }
  }

  return null;
}
