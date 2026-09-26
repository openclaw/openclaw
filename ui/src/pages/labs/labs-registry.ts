import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";

/** What a lab row writes at its gate. Most gates are booleans; some are modes. */
type LabFeatureValue = boolean | string;
type LabFeatureResetScope = "gate" | "parent" | null;

export type LabFeature = {
  id: string;
  title: () => string;
  description: () => string;
  docsUrl: string;
  /** Leaf whose value decides whether the row reads as on. */
  configPath: readonly [string, ...string[]];
  /**
   * Values written at `configPath`. Required rather than defaulted to `true` and
   * `false` so a setting that spells its on/off state as a mode has to say so
   * here instead of silently writing a boolean the runtime would ignore.
   */
  onValue: LabFeatureValue;
  offValue: LabFeatureValue;
  /**
   * Every value that reads as on, which is not always just `onValue`. A mode can
   * have settings broader than the one Labs offers, and those must render as
   * enabled — otherwise the row shows off, and clicking it narrows a choice the
   * operator made deliberately somewhere else.
   */
  activeValues: readonly LabFeatureValue[];
  /**
   * Replaces the leaf read when the runtime decides enablement from more than
   * one key. Receives the value at the gate's parent, which may be the boolean
   * shorthand. Must mirror the runtime resolver it cites, or the row will
   * misreport a config the runtime considers on.
   */
  readEnabled: ((raw: unknown) => boolean) | null;
  /**
   * Extra keys written beside the gate when enabling, relative to the gate's
   * parent. Labs pins the variant we actually recommend rather than inheriting
   * whatever a bare enable defaults to.
   */
  enableAlso: Readonly<Record<string, LabFeatureValue>> | null;
  /**
   * Ownership boundary for default provenance and reset. Most rows own only
   * their gate; features whose runtime default depends on any parent config
   * own and reset that parent as a unit. Required gates use null to keep their
   * explicit off value instead of deleting it.
   */
  resetScope: LabFeatureResetScope;
};

type LabFeatureState = {
  enabled: boolean;
  defaultEnabled: boolean;
  overridden: boolean;
};

function readConfiguredFeatureEnabled(
  raw: unknown,
  activeValues: readonly LabFeatureValue[],
): boolean {
  if (typeof raw === "boolean" || typeof raw === "string") {
    return activeValues.includes(raw);
  }
  if (!isRecord(raw)) {
    return false;
  }
  const enabled = raw.enabled;
  return typeof enabled === "boolean" || typeof enabled === "string"
    ? activeValues.includes(enabled)
    : Object.keys(raw).some((key) => key !== "enabled");
}

export const LAB_FEATURES = [
  {
    id: "codeMode",
    title: () => t("labsPage.codeMode.title"),
    description: () => t("labsPage.codeMode.description"),
    docsUrl: "https://docs.openclaw.ai/tools/code-mode",
    configPath: ["tools", "codeMode", "enabled"],
    // The on position writes the "auto" tier, never `true`: Labs offers
    // Auto/Off, and force-on for unevaluated models stays a config-only choice.
    onValue: "auto",
    offValue: false,
    activeValues: [true, "auto"],
    // Mirrors resolveCodeModeConfig: absence inherits auto; authored objects opt in.
    readEnabled: (raw) =>
      raw === undefined ||
      raw === true ||
      raw === "auto" ||
      (isRecord(raw) && (raw.enabled === true || raw.enabled === "auto")),
    enableAlso: null,
    resetScope: "gate",
  },
  {
    id: "toolSearch",
    title: () => t("labsPage.toolSearch.title"),
    description: () => t("labsPage.toolSearch.description"),
    docsUrl: "https://docs.openclaw.ai/tools/tool-search",
    configPath: ["tools", "toolSearch", "enabled"],
    onValue: true,
    offValue: false,
    activeValues: [true],
    // Mirrors resolveToolSearchConfig: unauthored config is on, while explicit
    // booleans and objects retain their own enablement semantics.
    readEnabled: (raw) => raw === undefined || readConfiguredFeatureEnabled(raw, [true]),
    // Explicit objects without a mode retain the legacy "code" surface.
    // Pin structured calls when writing an enabled override from Labs.
    enableAlso: { mode: "tools" },
    resetScope: "parent",
  },
  {
    id: "customPluginUi",
    title: () => t("labsPage.customPluginUi.title"),
    description: () => t("labsPage.customPluginUi.description"),
    docsUrl: "https://docs.openclaw.ai/plugins/feature-plugins",
    configPath: ["gateway", "controlUi", "experimental", "customPlugins"],
    onValue: true,
    offValue: false,
    activeValues: [true],
    readEnabled: null,
    enableAlso: null,
    resetScope: "gate",
  },
  {
    id: "hostDesktop",
    title: () => t("labsPage.hostDesktop.title"),
    description: () => t("labsPage.hostDesktop.description"),
    docsUrl: "https://docs.openclaw.ai/gateway/configuration-reference#desktop",
    configPath: ["desktop", "host", "enabled"],
    onValue: true,
    offValue: false,
    activeValues: [true],
    readEnabled: null,
    enableAlso: null,
    resetScope: null,
  },
  {
    id: "workerDesktop",
    title: () => t("labsPage.workerDesktop.title"),
    description: () => t("labsPage.workerDesktop.description"),
    docsUrl: "https://docs.openclaw.ai/gateway/cloud-workers#desktop-interactive",
    configPath: ["cloudWorkers", "desktop"],
    onValue: true,
    offValue: false,
    activeValues: [true],
    readEnabled: null,
    enableAlso: null,
    resetScope: "gate",
  },
] as const satisfies readonly LabFeature[];

function recordAtPath(config: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = config;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function readEnabledFromParent(feature: LabFeature, parent: unknown): boolean {
  const key = feature.configPath.at(-1);
  if (feature.readEnabled) {
    return feature.readEnabled(parent);
  }
  // Feature gates can accept a boolean or mode shorthand as well as the object
  // form. A registry path ending in `enabled` must reflect every active shape.
  if (key === "enabled" && (typeof parent === "boolean" || typeof parent === "string")) {
    return feature.activeValues.includes(parent);
  }
  if (!isRecord(parent) || !key) {
    return false;
  }
  return feature.activeValues.includes(parent[key] as LabFeatureValue);
}

function labFeatureOverridePath(
  config: Record<string, unknown>,
  feature: LabFeature,
): readonly string[] | null {
  const parentPath = feature.configPath.slice(0, -1);
  const key = feature.configPath.at(-1);
  const parent = recordAtPath(config, parentPath);
  if (!key) {
    return null;
  }
  if (feature.resetScope === "parent") {
    return parent === undefined ? null : parentPath;
  }
  // Boolean/string shorthands own the parent node rather than an `enabled`
  // child. Resetting the child would replace the shorthand with an empty object.
  if (
    key === "enabled" &&
    parent !== undefined &&
    (typeof parent !== "object" || parent === null)
  ) {
    return parentPath;
  }
  if (isRecord(parent) && Object.hasOwn(parent, key)) {
    return feature.configPath;
  }
  return null;
}

export function resolveLabFeatureState(
  config: Record<string, unknown> | null,
  feature: LabFeature,
): LabFeatureState {
  const source = config ?? {};
  const parentPath = feature.configPath.slice(0, -1);
  const key = feature.configPath.at(-1);
  const parent = recordAtPath(source, parentPath);
  const overridePath = labFeatureOverridePath(source, feature);
  let defaultParent = parent;
  if (overridePath?.length === parentPath.length) {
    defaultParent = undefined;
  } else if (overridePath && key && isRecord(parent)) {
    defaultParent = { ...(parent as Record<string, unknown>) };
    delete (defaultParent as Record<string, unknown>)[key];
  }
  return {
    enabled: readEnabledFromParent(feature, parent),
    defaultEnabled: readEnabledFromParent(feature, defaultParent),
    overridden: overridePath !== null,
  };
}

export function labFeatureMergePatch(
  feature: LabFeature,
  enabled: boolean,
): Record<string, unknown> {
  const key = feature.configPath.at(-1) as string;
  // Companion keys ride in the same patch as the gate so one save cannot leave
  // the feature on in a variant Labs never offered.
  let patch: unknown = {
    [key]: enabled ? feature.onValue : feature.offValue,
    ...(enabled ? feature.enableAlso : null),
  };
  for (const segment of feature.configPath.slice(0, -1).toReversed()) {
    patch = { [segment]: patch };
  }
  return patch as Record<string, unknown>;
}

export function labFeatureResetPatch(
  config: Record<string, unknown> | null,
  feature: LabFeature,
): Record<string, unknown> | null {
  if (feature.resetScope === null) {
    return null;
  }
  const path = labFeatureOverridePath(config ?? {}, feature);
  if (!path?.length) {
    return null;
  }
  let patch: unknown = null;
  for (const segment of path.toReversed()) {
    patch = { [segment]: patch };
  }
  return patch as Record<string, unknown>;
}
