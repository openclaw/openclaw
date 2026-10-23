import { isRecord } from "@openclaw/normalization-core/record-coerce";

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
  /** Plugin whose own settings page owns this lab's options; Labs links there. */
  settingsPluginId?: string;
};

export type LabFeatureDefinition = Omit<LabFeature, "title" | "description">;

type LabFeatureState = {
  enabled: boolean;
  defaultEnabled: boolean;
  overridden: boolean;
};

export const BOOLEAN_GATE = {
  onValue: true,
  offValue: false,
  activeValues: [true],
  readEnabled: null,
  enableAlso: null,
  resetScope: "gate",
} as const;

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

function readEnabledFromParent(feature: LabFeatureDefinition, parent: unknown): boolean {
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
  const value = parent[key];
  return feature.activeValues.some((active) => active === value);
}

export function labFeatureOverridePath(
  config: Record<string, unknown>,
  feature: LabFeatureDefinition,
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
  feature: LabFeatureDefinition,
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
