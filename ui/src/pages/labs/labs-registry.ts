import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../lib/reactive/i18n.ts";
import {
  BOOLEAN_GATE,
  labFeatureOverridePath,
  type LabFeature,
  type LabFeatureDefinition,
} from "./labs-feature-state.ts";
import { TEMPLATES_LAB_FEATURE } from "./templates-lab-feature.ts";

export const LAB_FEATURES = (
  [
    {
      ...BOOLEAN_GATE,
      id: "decisionAssistance",
      configPath: ["agents", "defaults", "experimental", "decisionAssistance"],
    },
    {
      ...BOOLEAN_GATE,
      id: "codeMode",
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
      id: "usageRankedToolIndex",
      configPath: ["agents", "defaults", "experimental", "usageRankedToolIndex"],
    },
    {
      ...BOOLEAN_GATE,
      id: "composerPredictions",
      configPath: ["gateway", "controlUi", "experimental", "composerPredictions", "enabled"],
    },
    {
      ...BOOLEAN_GATE,
      id: "chatBubbles",
      configPath: ["gateway", "controlUi", "experimental", "chatBubbles"],
    },
    TEMPLATES_LAB_FEATURE,
    {
      ...BOOLEAN_GATE,
      id: "hostDesktop",
      configPath: ["desktop", "host", "enabled"],
      resetScope: null,
    },
    {
      ...BOOLEAN_GATE,
      id: "openclawId",
      configPath: ["gateway", "openclawId", "enabled"],
      // Off writes false and keeps the service URLs an operator configured.
      resetScope: null,
    },
    {
      ...BOOLEAN_GATE,
      id: "workerDesktop",
      configPath: ["cloudWorkers", "desktop"],
    },
  ] as const satisfies readonly LabFeatureDefinition[]
).map((feature) =>
  Object.assign({}, feature, {
    title: () => t(`labsPage.${feature.id}.title`),
    description: () => t(`labsPage.${feature.id}.description`),
  }),
);

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
