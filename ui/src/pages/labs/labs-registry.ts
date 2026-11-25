import { t } from "../../lib/reactive/i18n.ts";
import {
  BOOLEAN_GATE,
  labFeatureOverridePath,
  type LabFeature,
  type LabFeatureDefinition,
} from "./labs-feature-state.ts";

export const LAB_FEATURES = (
  [
    {
      ...BOOLEAN_GATE,
      id: "decisionAssistance",
      configPath: ["agents", "defaults", "experimental", "decisionAssistance"],
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
  let patch: unknown = { [key]: enabled };
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
