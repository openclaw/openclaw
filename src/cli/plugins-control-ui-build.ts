import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CONTROL_UI_PLUGIN_MAX_ASSET_BYTES,
  CONTROL_UI_PLUGIN_MAX_ASSETS,
  CONTROL_UI_PLUGIN_MAX_BUILD_BYTES,
  isPluginControlUiAssetPath,
  pluginControlUiGenerationHash,
} from "../plugins/control-ui-assets.js";
import { normalizeManifestControlUi } from "../plugins/manifest-control-ui.js";
import type { PluginManifestControlUi } from "../plugins/manifest-types.js";
import { PLUGIN_MANIFEST_FILENAME } from "../plugins/manifest.js";
import { buildPluginLoaderAliasMap } from "../plugins/sdk-alias.js";
import { buildPluginBundle } from "./plugins-build-bundle.js";
import { nameControlUiChunks } from "./plugins-control-ui-chunks.js";

export async function writePluginBuildManifest(
  rootDir: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const realRootDir = await fs.realpath(rootDir);
  // Keep package directory permissions intact and retain ordinary umask-based
  // creation for new manifests while preserving existing manifest permissions.
  await replaceFileAtomic({
    filePath: path.join(realRootDir, PLUGIN_MANIFEST_FILENAME),
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    mode: 0o666 & ~process.umask(),
    preserveExistingMode: true,
    dirMode: "preserve",
    syncTempFile: true,
    syncParentDir: true,
    throwOnCleanupError: true,
  });
}

export async function buildPluginControlUi(params: {
  rootDir: string;
  source: string;
  check?: boolean;
}): Promise<PluginManifestControlUi> {
  const rootDir = await fs.realpath(params.rootDir);
  const manifestText = await fs
    .readFile(path.join(rootDir, PLUGIN_MANIFEST_FILENAME), "utf8")
    .catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return "{}";
      }
      throw error;
    });
  const authored: unknown = JSON.parse(manifestText);
  const presentation = normalizeManifestControlUi(
    isRecord(authored) ? authored.controlUi : undefined,
    isRecord(authored) ? authored.channels : undefined,
  );
  if (!presentation.ok) {
    throw new Error(presentation.error);
  }
  const entry = await fs.realpath(path.resolve(rootDir, params.source));
  const relative = path.relative(rootDir, entry);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Control UI source must stay inside the plugin package.");
  }
  const buildDir = path.join(rootDir, "dist/control-ui/build");
  const outputs = await buildPluginBundle({
    absWorkingDir: rootDir,
    entryPoints: { index: entry },
    outdir: buildDir,
    splitting: true,
    chunkNames: "chunk-[hash]",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    sourcemap: false,
    tsconfigRaw: {
      compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
    },
    // Browser bundles embed the host SDK and workspace packages, so resolve them
    // from source whenever a source checkout is present. NODE_ENV=production would
    // otherwise prefer compiled dist left behind by an earlier build, and stale
    // bytes change the content hash that openclaw.plugin.json commits.
    alias: buildPluginLoaderAliasMap(entry, process.argv[1], import.meta.url, "src"),
  });
  // esbuild hashes input paths into JS chunk names, including physical package
  // store paths. Preserve module graph identity without binding asset identity
  // to checkout location; the generation hash below covers every final byte.
  const rawFiles = outputs.map((file) => ({
    name: path.relative(buildDir, file.path),
    contents: file.contents,
  }));
  // Reject unsafe or oversized raw output before graph parsing or renaming.
  validateControlUiFiles(rawFiles);
  const files = nameControlUiChunks(rawFiles);
  validateControlUiFiles(files);
  const output = `dist/control-ui/${pluginControlUiGenerationHash(files)}`;
  const outputDir = path.join(rootDir, output);
  const declaration = {
    ...(presentation.value?.activation ? { activation: presentation.value.activation } : {}),
    ...(presentation.value?.settingsViews
      ? { settingsViews: presentation.value.settingsViews }
      : {}),
    entry: `${output}/index.js`,
    ...(files.some((file) => file.name === "index.css") ? { styles: [`${output}/index.css`] } : {}),
  };
  if (params.check) {
    for (const file of files) {
      const existing = await fs.readFile(path.join(outputDir, file.name)).catch(() => null);
      if (!existing?.equals(Buffer.from(file.contents))) {
        throw new Error("Control UI build is missing or stale. Run openclaw plugins build.");
      }
    }
    return declaration;
  }

  // Publish an immutable directory before its manifest pointer. A failed build
  // cannot change the previous activation or expose a mixed JS/CSS generation.
  const generations = path.dirname(outputDir);
  await fs.mkdir(generations, { recursive: true });
  // The builder owns this parent too; a restrictive umask would otherwise leave
  // it owner-only and block traversal before the generation is ever reached.
  await fs.chmod(generations, 0o755);
  const staging = await fs.mkdtemp(path.join(generations, ".build-"));
  try {
    for (const file of files) {
      await fs.writeFile(path.join(staging, file.name), file.contents);
    }
    await normalizeGenerationPermissions(staging, files);
    try {
      await fs.rename(staging, outputDir);
    } catch (error) {
      // Windows reports an existing destination directory as EPERM; reuse still requires matching bytes.
      if (
        !isRecord(error) ||
        (error.code !== "EEXIST" && error.code !== "ENOTEMPTY" && error.code !== "EPERM")
      ) {
        throw error;
      }
      for (const file of files) {
        const existing = await fs.readFile(path.join(outputDir, file.name));
        if (!existing.equals(Buffer.from(file.contents))) {
          throw new Error(
            "An immutable Control UI build was modified. Remove that build and rebuild.",
            { cause: error },
          );
        }
      }
      // A generation published by an earlier build may still carry owner-only modes.
      await normalizeGenerationPermissions(outputDir, files);
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return declaration;
}

function validateControlUiFiles(files: Array<{ name: string; contents: Uint8Array }>): void {
  if (files.length > CONTROL_UI_PLUGIN_MAX_ASSETS) {
    throw new Error(`Control UI builds allow at most ${CONTROL_UI_PLUGIN_MAX_ASSETS} assets.`);
  }
  if (
    files.some((file) => file.contents.length > CONTROL_UI_PLUGIN_MAX_ASSET_BYTES) ||
    files.reduce((total, file) => total + file.contents.length, 0) >
      CONTROL_UI_PLUGIN_MAX_BUILD_BYTES
  ) {
    throw new Error(
      "Control UI builds allow at most 4 MiB per asset and 8 MiB per plugin. Reduce the browser bundle before installing.",
    );
  }
  if (
    !files.some((file) => file.name === "index.js") ||
    files.some(
      (file) => file.name !== path.basename(file.name) || !isPluginControlUiAssetPath(file.name),
    )
  ) {
    throw new Error(
      "Control UI build must produce a JavaScript entrypoint and only flat JavaScript/CSS assets.",
    );
  }
}

// mkdtemp is owner-only and file creation follows umask. Normalize generated
// asset modes before publication or after validating a reused generation.
async function normalizeGenerationPermissions(directory: string, files: Array<{ name: string }>) {
  await fs.chmod(directory, 0o755);
  for (const file of files) {
    await fs.chmod(path.join(directory, file.name), 0o644);
  }
}
