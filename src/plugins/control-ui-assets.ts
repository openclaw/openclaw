import { createHash } from "node:crypto";
import path from "node:path";
import type { PluginUiCapability } from "../../packages/gateway-protocol/src/plugin-ui-capabilities.js";
import {
  normalizeSessionIconValue,
  SESSION_ICON_SVG_MAX_BYTES,
} from "../../packages/gateway-protocol/src/session-agent-status.js";
import { root } from "../infra/fs-safe.js";
import { walkRootDirectory } from "../infra/root-walk.js";
import type { PluginManifestControlUi } from "./manifest-types.js";

export const CONTROL_UI_PLUGIN_MAX_ASSET_BYTES = 4 * 1024 * 1024;
export const CONTROL_UI_PLUGIN_MAX_BUILD_BYTES = 8 * 1024 * 1024;
export const CONTROL_UI_PLUGIN_MAX_ASSETS = 128;

export type PluginControlUiAsset = { body: Buffer; contentType: string };

/** Identity of the complete immutable browser generation produced by the CLI. */
export function pluginControlUiGenerationHash(
  files: readonly { name: string; contents: Uint8Array }[],
): string {
  const digest = createHash("sha256");
  for (const file of files.toSorted((left, right) => left.name.localeCompare(right.name))) {
    digest.update(`${file.name}\0${file.contents.length}\0`).update(file.contents);
  }
  return digest.digest("hex");
}

/** Shared by the live catalog and the packaged UI inventory; keep this byte contract stable. */
export function pluginControlUiRevision(
  declaration: PluginManifestControlUi,
  uiCapabilities: readonly PluginUiCapability[] | undefined,
  assets: ReadonlyMap<string, PluginControlUiAsset>,
  panelIcon?: string,
): string {
  const digest = createHash("sha256").update(
    JSON.stringify({ declaration, uiCapabilities, panelIcon }),
  );
  for (const [name, asset] of [...assets].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    digest.update(`${name}\0${asset.body.length}\0`).update(asset.body);
  }
  return digest.digest("hex");
}

/** Files admitted from a plugin's dedicated browser build directory. */
export function isPluginControlUiAssetPath(relativePath: string): boolean {
  return /^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.(?:m?js|css)$/u.test(relativePath);
}

// Serving and packing must capture the same bounded browser directory, including
// dependent chunks, without exposing package sources or unrelated files.
// CLI packing stays strict; Gateway callers supply the owning plugin's hardlink policy.
export async function readPluginControlUiAssets(
  rootDir: string,
  declaration: PluginManifestControlUi,
  options: { rejectHardlinks?: boolean } = {},
) {
  const pluginRoot = await root(rootDir, {
    hardlinks: options.rejectHardlinks === false ? "allow" : "reject",
    symlinks: "reject",
    maxBytes: CONTROL_UI_PLUGIN_MAX_ASSET_BYTES,
  });
  const directory = path.posix.dirname(declaration.entry);
  const assets = new Map<string, PluginControlUiAsset>();
  let bytes = 0;
  for await (const entry of walkRootDirectory(pluginRoot.rootReal, directory, {
    symlinkPolicy: "skip",
    maxDepth: 8,
    maxEntries: CONTROL_UI_PLUGIN_MAX_ASSETS,
    limitBehavior: "throw",
  })) {
    const relativePath = path.posix.relative(directory, entry.relativePath);
    if (entry.kind !== "file" || !isPluginControlUiAssetPath(relativePath)) {
      continue;
    }
    const body = await pluginRoot.readBytes(entry.relativePath);
    bytes += body.length;
    if (bytes > CONTROL_UI_PLUGIN_MAX_BUILD_BYTES) {
      throw new Error("browser build exceeds its byte limit");
    }
    assets.set(relativePath, {
      body,
      contentType: relativePath.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8",
    });
  }
  const entryName = path.posix.basename(declaration.entry);
  const styles = (declaration.styles ?? []).map((style) => path.posix.relative(directory, style));
  if (![entryName, ...styles].every((name) => assets.has(name))) {
    throw new Error("declared browser assets are missing");
  }
  let panelIcon: { path: string; body: Buffer; dataUrl: string } | undefined;
  if (declaration.panelIcon) {
    try {
      const body = await pluginRoot.readBytes(declaration.panelIcon, {
        maxBytes: SESSION_ICON_SVG_MAX_BYTES,
      });
      const source = body.toString("utf8").trim();
      const dataUrl = source.startsWith("<") ? normalizeSessionIconValue(source) : null;
      if (dataUrl) {
        panelIcon = { path: declaration.panelIcon, body, dataUrl };
        bytes += body.length;
      }
    } catch {
      // Optional artwork never disables a healthy browser module. The root owner
      // rejects symlinks, escaping paths, disallowed hardlinks, and oversized files.
    }
  }
  return { directory, entryName, styles, assets, bytes, panelIcon };
}
