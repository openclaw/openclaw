import type { ControlUiSettingsPlacement } from "../../packages/gateway-protocol/src/plugin-control-ui-settings.js";
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
  channels: unknown = [],
): Result<PluginManifestControlUi | undefined, string> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["entry", "styles", "panelIcon", "activation", "settingsViews"].includes(key),
    )
  ) {
    return err("controlUi contains an unknown field");
  }
  if (value.activation !== undefined && value.activation !== "settings-only") {
    return err("controlUi.activation must be settings-only when specified");
  }
  const ownedChannels = new Set(Array.isArray(channels) ? channels : []);
  const settingsViews: ControlUiSettingsPlacement[] = [];
  const placements = new Set<string>();
  if (value.settingsViews !== undefined) {
    if (
      !Array.isArray(value.settingsViews) ||
      value.settingsViews.length === 0 ||
      value.settingsViews.length > 32
    ) {
      return err("controlUi.settingsViews must declare unique Settings placements");
    }
    for (const placement of value.settingsViews) {
      if (!isRecord(placement)) {
        return err("invalid Control UI Settings placement");
      }
      const keys = Object.keys(placement).filter(
        (key) => key !== "requiredMethods" && key !== "search",
      );
      if (
        placement.requiredMethods !== undefined &&
        (!Array.isArray(placement.requiredMethods) ||
          placement.requiredMethods.length > 16 ||
          placement.requiredMethods.some(
            (method) => typeof method !== "string" || !method.trim() || method.length > 200,
          ))
      ) {
        return err("Settings requiredMethods must name advertised Gateway methods");
      }
      if (
        placement.search !== undefined &&
        (!isRecord(placement.search) ||
          Object.keys(placement.search).some(
            (key) => !["label", "hash", "aliases"].includes(key),
          ) ||
          typeof placement.search.label !== "string" ||
          !placement.search.label.trim() ||
          placement.search.label.length > 200 ||
          typeof placement.search.hash !== "string" ||
          placement.search.hash.length > 200 ||
          typeof placement.search.aliases !== "string" ||
          placement.search.aliases.length > 1000)
      ) {
        return err("Settings search must name its label, hash, and search aliases");
      }
      let normalized: ControlUiSettingsPlacement;
      if (
        keys.length === 2 &&
        placement.section === "memory" &&
        (placement.panel === "overview" || placement.panel === "memories")
      ) {
        normalized = { section: "memory", panel: placement.panel };
      } else if (
        keys.length === 3 &&
        placement.section === "profile" &&
        placement.panel === "connections" &&
        typeof placement.id === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(placement.id)
      ) {
        normalized = { id: placement.id, section: "profile", panel: "connections" };
      } else if (
        keys.length === 3 &&
        placement.section === "agents" &&
        placement.panel === "tools" &&
        typeof placement.id === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(placement.id)
      ) {
        normalized = { id: placement.id, section: "agents", panel: "tools" };
      } else if (
        keys.length === 3 &&
        placement.section === "channels" &&
        placement.panel === "detail" &&
        typeof placement.channelId === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(placement.channelId) &&
        ownedChannels.has(placement.channelId)
      ) {
        normalized = { section: "channels", panel: "detail", channelId: placement.channelId };
      } else {
        return err("Control UI Settings placement must name a supported Settings destination");
      }
      const key = "id" in normalized ? normalized.id : JSON.stringify(normalized);
      if (placements.has(key)) {
        return err("controlUi.settingsViews must declare unique Settings placements");
      }
      placements.add(key);
      settingsViews.push({
        ...normalized,
        ...(placement.requiredMethods ? { requiredMethods: [...placement.requiredMethods] } : {}),
        ...(isRecord(placement.search)
          ? {
              search: {
                label: String(placement.search.label),
                hash: String(placement.search.hash),
                aliases: String(placement.search.aliases),
              },
            }
          : {}),
      });
    }
  }
  if (value.activation === "settings-only" && !value.settingsViews) {
    return err("settings-only Control UI requires a Settings placement");
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
  const panelIcon =
    typeof value.panelIcon === "string" ? value.panelIcon.replace(/^\.\//u, "") : undefined;
  if (
    value.panelIcon !== undefined &&
    (!panelIcon ||
      panelIcon.length > 512 ||
      !/^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.svg$/u.test(panelIcon))
  ) {
    return err("controlUi.panelIcon must be a plugin-relative SVG path");
  }
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
  return ok({
    entry,
    ...(panelIcon ? { panelIcon } : {}),
    ...(styles.length > 0 ? { styles } : {}),
    ...(value.activation === "settings-only" ? { activation: value.activation } : {}),
    ...(settingsViews.length > 0 ? { settingsViews } : {}),
  });
}
