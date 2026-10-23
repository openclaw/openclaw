import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import { type BuildProvenance, resolveRuntimeServiceBuildProvenance } from "../version.js";

const BUNDLED_CODE_IDENTITY_PREFIX = "bundled-build:";

function realpathOrUndefined(target: string): string | undefined {
  try {
    return fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

/**
 * Code identity of a core-bundled plugin that loads host-owned modules instead of captured
 * source: the exact OpenClaw build this process loaded plus the plugin's ID and real entry and
 * root inside that build's own output.
 *
 * Every build writes `dist/build-info.json` last, after cleaning the previous output, recording its
 * version, commit and build time beside a build ID, and the process reads it once when it starts.
 * The whole record counts: an explicit UI build ID can repeat across builds, the build time cannot
 * unless a reproducible build of the same commit pins it. A host upgrade, downgrade or rebuild
 * therefore never matches, and a failed build has no record at all. A plugin outside that build's
 * `dist` or `dist-runtime` extensions (a source checkout or an override directory) is not part of
 * the build and has no identity, so its schedules keep ending with the Gateway process.
 */
export function resolveBundledPluginCodeIdentity(
  plugin: { id: string; source: string; rootDir?: string },
  build: BuildProvenance | null = resolveRuntimeServiceBuildProvenance(),
): string | undefined {
  // Every OpenClaw build records its build time; a record without one is not a build's own.
  if (!build?.buildInfoPath || !build.builtAt || !plugin.rootDir) {
    return undefined;
  }
  const distDir = path.dirname(build.buildInfoPath);
  if (path.basename(distDir) !== "dist") {
    return undefined;
  }
  const packageRoot = path.dirname(distDir);
  const root = realpathOrUndefined(plugin.rootDir);
  const entry = realpathOrUndefined(plugin.source);
  if (!root || !entry || !isPathInside(root, entry)) {
    return undefined;
  }
  const builtExtensions = ["dist", "dist-runtime"]
    .map((output) => realpathOrUndefined(path.join(packageRoot, output, "extensions")))
    .filter((dir): dir is string => dir !== undefined);
  if (!builtExtensions.some((dir) => root !== dir && isPathInside(dir, root))) {
    return undefined;
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "openclaw-bundled-plugin-code-v1",
        build.buildId,
        build.version ?? null,
        build.commit ?? null,
        build.builtAt,
        plugin.id,
        root,
        entry,
      ]),
    )
    .digest("hex");
  return BUNDLED_CODE_IDENTITY_PREFIX + digest;
}
