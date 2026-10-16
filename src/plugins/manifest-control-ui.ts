import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import { err, ok, type Result } from "../../packages/normalization-core/src/result.js";
import type { PluginManifestControlUi } from "./manifest-types.js";

/** Package authoring metadata names source; the runtime manifest names only built assets. */
export function controlUiSource(packageManifest: Record<string, unknown>): string | undefined {
  const source = isRecord(packageManifest.openclaw)
    ? packageManifest.openclaw.controlUi
    : undefined;
  if (source === undefined) {
    return undefined;
  }
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("package.json openclaw.controlUi must name a browser source entrypoint.");
  }
  return source;
}

export function normalizeManifestControlUi(
  value: unknown,
): Result<PluginManifestControlUi | undefined, string> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "entry" && key !== "styles")) {
    return err("controlUi must contain only entry and optional styles");
  }
  const entry = typeof value.entry === "string" ? value.entry.replace(/^\.\//u, "") : "";
  // A dedicated built directory prevents a declaration from publishing package sources.
  const builtEntry = /^dist\/(?:[\w-][\w.-]*\/)+[\w-][\w.-]*\.m?js$/u;
  if (entry.length > 512 || !builtEntry.test(entry)) {
    return err("controlUi.entry must be a JavaScript file in a dedicated dist subdirectory");
  }
  if (value.styles !== undefined && (!Array.isArray(value.styles) || value.styles.length > 16)) {
    return err("controlUi.styles must be an array of at most 16 stylesheets");
  }
  const assetPrefix = entry.slice(0, entry.lastIndexOf("/") + 1);
  const styles: string[] = [];
  for (const rawStyle of value.styles ?? []) {
    const style = typeof rawStyle === "string" ? rawStyle.replace(/^\.\//u, "") : "";
    if (
      style.length > 512 ||
      !style.startsWith(assetPrefix) ||
      !/^(?:[\w-][\w.-]*\/)+[\w-][\w.-]*\.css$/u.test(style)
    ) {
      return err("controlUi.styles must contain CSS files under the entry's asset directory");
    }
    if (!styles.includes(style)) {
      styles.push(style);
    }
  }
  return ok({ entry, ...(styles.length > 0 ? { styles } : {}) });
}
