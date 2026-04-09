import fs from "node:fs";
import path from "node:path";
import { resolveBundledPluginsDir } from "./bundled-dir.js";

const PUBLIC_SURFACE_SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"] as const;

export function normalizeBundledPluginArtifactSubpath(artifactBasename: string): string {
  if (
    path.posix.isAbsolute(artifactBasename) ||
    path.win32.isAbsolute(artifactBasename) ||
    artifactBasename.includes("\\")
  ) {
    throw new Error(`Bundled plugin artifact path must stay plugin-local: ${artifactBasename}`);
  }

  const normalized = artifactBasename.replace(/^\.\//u, "");
  if (!normalized) {
    throw new Error("Bundled plugin artifact path must not be empty");
  }

  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === ".." || segment.includes(":"),
    )
  ) {
    throw new Error(`Bundled plugin artifact path must stay plugin-local: ${artifactBasename}`);
  }

  return normalized;
}

export function resolveBundledPluginPublicSurfacePath(params: {
  rootDir: string;
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
  bundledPluginsDir?: string;
}): string | null {
  const artifactBasename = normalizeBundledPluginArtifactSubpath(params.artifactBasename);

  const explicitBundledPluginsDir =
    params.bundledPluginsDir ?? resolveBundledPluginsDir(params.env ?? process.env);
  if (explicitBundledPluginsDir) {
    const explicitPluginDir = path.resolve(explicitBundledPluginsDir, params.dirName);
    const explicitBuiltCandidate = path.join(explicitPluginDir, artifactBasename);
    if (fs.existsSync(explicitBuiltCandidate)) {
      return explicitBuiltCandidate;
    }

    const sourceBaseName = artifactBasename.replace(/\.js$/u, "");
    for (const ext of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
      const sourceCandidate = path.join(explicitPluginDir, `${sourceBaseName}${ext}`);
      if (fs.existsSync(sourceCandidate)) {
        return sourceCandidate;
      }
    }
  }

  for (const candidate of [
    path.resolve(params.rootDir, "dist", "extensions", params.dirName, artifactBasename),
    path.resolve(params.rootDir, "dist-runtime", "extensions", params.dirName, artifactBasename),
  ]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
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
