import { isRecord } from "@openclaw/normalization-core/record-coerce";

type LabFeatureResetScope = "gate" | null;

export type LabFeature = {
  id: string;
  title: () => string;
  description: () => string;
  /** Leaf whose value decides whether the row reads as on. */
  configPath: readonly [string, ...string[]];
  /** Reset the parent when its presence changes defaults; null retains required gates. */
  resetScope: LabFeatureResetScope;
};

export type LabFeatureDefinition = Omit<LabFeature, "title" | "description">;

export const BOOLEAN_GATE = {
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
  if (key === "enabled" && typeof parent === "boolean") {
    return parent;
  }
  if (!isRecord(parent) || !key) {
    return false;
  }
  const value = parent[key];
  return value === true;
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
) {
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
