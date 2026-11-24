import type { ControlUiSettingsPlacement } from "../../packages/gateway-protocol/src/plugin-control-ui-settings.js";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import { err, ok, type Result } from "../../packages/normalization-core/src/result.js";
import type {
  PluginManifestControlUi,
  PluginManifestControlUiSettingsView,
} from "./manifest-types.js";

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

/** Dot-separated segments after the namespace; a final ".*" names one row per item. */
const SETTING_ID_PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?:\.\*)?$/u;
/** Plain ASCII, no outer spaces, at most 80 characters. */
const SETTING_LABEL = /^[\x21-\x7E](?:[\x20-\x7E]{0,78}[\x21-\x7E])?$/u;
const MAX_VIEW_SETTINGS = 200;

/**
 * The settings one view draws, keyed by setting ID. IDs stay in namespaces the plugin owns,
 * so a plugin cannot claim a core setting or another plugin's.
 */
function normalizeViewSettings(
  value: unknown,
  pluginId: unknown,
  ownedChannels: ReadonlySet<unknown>,
  claimed: Set<string>,
): Result<PluginManifestControlUiSettingsView["settings"], string> {
  if (!isRecord(value) || Object.keys(value).length > MAX_VIEW_SETTINGS) {
    return err(
      "controlUi.settingsViews[].settings must map each setting ID the view draws to { label }; declare {} when the view draws no setting",
    );
  }
  const namespaces = [
    ...[...ownedChannels].map((channel) => "channels." + String(channel) + "."),
    ...(typeof pluginId === "string" && pluginId
      ? ["plugins.entries." + pluginId + ".", "plugin." + pluginId + "."]
      : []),
  ];
  const settings: Record<string, { label: string }> = {};
  for (const [id, entry] of Object.entries(value)) {
    const namespace = namespaces.find((candidate) => id.startsWith(candidate));
    if (!namespace || id.length > 200 || !SETTING_ID_PATH.test(id.slice(namespace.length))) {
      return err(
        "controlUi.settingsViews[].settings: setting ID " +
          JSON.stringify(id) +
          " must continue one of " +
          (namespaces.map((candidate) => JSON.stringify(candidate)).join(", ") || "no namespace") +
          " (an owned channel's config, the plugin's config, or a UI-only \"plugin.<plugin id>.\" name)",
      );
    }
    if (claimed.has(id)) {
      return err(
        "controlUi.settingsViews[].settings: setting ID " +
          JSON.stringify(id) +
          " is declared by more than one view",
      );
    }
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 1 ||
      typeof entry.label !== "string" ||
      !SETTING_LABEL.test(entry.label)
    ) {
      return err(
        "controlUi.settingsViews[].settings[" +
          JSON.stringify(id) +
          "] must be { label } with the row's English title in plain ASCII, at most 80 characters",
      );
    }
    claimed.add(id);
    settings[id] = { label: entry.label };
  }
  return ok(settings);
}

export function normalizeManifestControlUi(
  value: unknown,
  channels: unknown,
  pluginId: unknown,
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
  const settingsViews: PluginManifestControlUiSettingsView[] = [];
  const placements = new Set<string>();
  const claimed = new Set<string>();
  if (value.settingsViews !== undefined) {
    if (
      !Array.isArray(value.settingsViews) ||
      value.settingsViews.length === 0 ||
      value.settingsViews.length > 2 + ownedChannels.size
    ) {
      return err("controlUi.settingsViews must declare unique Settings placements");
    }
    for (const placement of value.settingsViews) {
      if (!isRecord(placement)) {
        return err("invalid Control UI Settings placement");
      }
      let normalized: ControlUiSettingsPlacement;
      // Every view lists the settings it draws, even when that list is empty.
      if (!("settings" in placement)) {
        return err(
          "controlUi.settingsViews[].settings is required: list the setting IDs the view draws, or {} for none",
        );
      }
      if (
        Object.keys(placement).length === 3 &&
        placement.section === "memory" &&
        (placement.panel === "overview" || placement.panel === "memories")
      ) {
        normalized = { section: "memory", panel: placement.panel };
      } else if (
        Object.keys(placement).length === 4 &&
        placement.section === "channels" &&
        placement.panel === "detail" &&
        typeof placement.channelId === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(placement.channelId) &&
        ownedChannels.has(placement.channelId)
      ) {
        normalized = { section: "channels", panel: "detail", channelId: placement.channelId };
      } else {
        return err("Control UI Settings placement must name Memory or an owned channel detail");
      }
      const key = JSON.stringify(normalized);
      if (placements.has(key)) {
        return err("controlUi.settingsViews must declare unique Settings placements");
      }
      placements.add(key);
      const settings = normalizeViewSettings(placement.settings, pluginId, ownedChannels, claimed);
      if (!settings.ok) {
        return settings;
      }
      settingsViews.push({ ...normalized, settings: settings.value });
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
