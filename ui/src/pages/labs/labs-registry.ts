import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { registerLabsEnglish } from "../../i18n/locales/en-labs.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerLabsEnglish);

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
  /** Explicit writes preserve gates whose on/off values are modes, not booleans. */
  onValue: LabFeatureValue;
  offValue: LabFeatureValue;
  /** Include broader enabled modes so the toggle never narrows an existing choice. */
  activeValues: readonly LabFeatureValue[];
  /** Runtime-owned enablement from the parent, including boolean shorthand. */
  readEnabled: ((raw: unknown) => boolean) | null;
  /** Sibling writes pin the recommended variant rather than a bare enable's defaults. */
  enableAlso: Readonly<Record<string, LabFeatureValue>> | null;
  /** Reset the parent when its presence changes defaults; null retains required gates. */
  resetScope: LabFeatureResetScope;
};

type LabFeatureState = {
  enabled: boolean;
  defaultEnabled: boolean;
  overridden: boolean;
};

const BOOLEAN_GATE = {
  onValue: true,
  offValue: false,
  activeValues: [true],
  readEnabled: null,
  enableAlso: null,
  resetScope: "gate",
} as const;

export const LAB_FEATURES = (
  [
    {
      ...BOOLEAN_GATE,
      id: "decisionAssistance",
      docsUrl: "https://docs.openclaw.ai/concepts/experimental-features#decision-assistance",
      configPath: ["agents", "defaults", "experimental", "decisionAssistance"],
    },
    {
      ...BOOLEAN_GATE,
      id: "codeMode",
      docsUrl: "https://docs.openclaw.ai/tools/code-mode",
      configPath: ["tools", "codeMode", "enabled"],
      // The on position writes the "auto" tier, never `true`: Labs offers
      // Auto/Off, and force-on for unevaluated models stays a config-only choice.
      onValue: "auto",
      activeValues: [true, "auto"],
      // Mirrors resolveCodeModeConfig: absence inherits auto; authored objects opt in.
      readEnabled: (raw) =>
        raw === undefined ||
        raw === true ||
        raw === "auto" ||
        (isRecord(raw) && (raw.enabled === true || raw.enabled === "auto")),
    },
    {
      ...BOOLEAN_GATE,
      id: "toolSearch",
      docsUrl: "https://docs.openclaw.ai/tools/tool-search",
      configPath: ["tools", "toolSearch", "enabled"],
      // Mirrors resolveToolSearchConfig: unauthored config is on, while explicit
      // booleans and objects retain their own enablement semantics.
      readEnabled: (raw) =>
        raw === undefined ||
        raw === true ||
        (isRecord(raw) &&
          (typeof raw.enabled === "boolean" || typeof raw.enabled === "string"
            ? raw.enabled === true
            : Object.keys(raw).some((key) => key !== "enabled"))),
      // Explicit objects without a mode retain the legacy "code" surface.
      // Pin structured calls when writing an enabled override from Labs.
      enableAlso: { mode: "tools" },
      resetScope: "parent",
    },
    {
      ...BOOLEAN_GATE,
      id: "customPluginUi",
      docsUrl: "https://docs.openclaw.ai/plugins/feature-plugins",
      configPath: ["gateway", "controlUi", "experimental", "customPlugins"],
    },
    {
      ...BOOLEAN_GATE,
      id: "hostDesktop",
      docsUrl: "https://docs.openclaw.ai/gateway/configuration-reference#desktop",
      configPath: ["desktop", "host", "enabled"],
      resetScope: null,
    },
    {
      ...BOOLEAN_GATE,
      id: "workerDesktop",
      docsUrl: "https://docs.openclaw.ai/gateway/cloud-workers#desktop-interactive",
      configPath: ["cloudWorkers", "desktop"],
    },
  ] as const satisfies readonly Omit<LabFeature, "title" | "description">[]
).map((feature) =>
  Object.assign({}, feature, {
    title: () => t(`labsPage.${feature.id}.title`),
    description: () => t(`labsPage.${feature.id}.description`),
  }),
);

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
    const { [key]: _override, ...defaults } = parent;
    defaultParent = defaults;
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
