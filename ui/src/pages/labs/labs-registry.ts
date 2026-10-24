import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../lib/reactive/i18n.ts";
import { CLAWS_LAB_FEATURE } from "./claws-lab-feature.ts";
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
      id: "advisor",
      docsUrl: "https://docs.openclaw.ai/concepts/experimental-features#advisor",
      configPath: ["plugins", "entries", "advisor", "enabled"],
      settingsPluginId: "advisor",
    },
    {
      ...BOOLEAN_GATE,
      id: "composerPredictions",
      docsUrl: "https://docs.openclaw.ai/web/control-ui/chat#composer-predictions",
      configPath: ["gateway", "controlUi", "experimental", "composerPredictions", "enabled"],
    },
    {
      ...BOOLEAN_GATE,
      id: "chatBubbles",
      docsUrl: "https://docs.openclaw.ai/web/control-ui/chat",
      configPath: ["gateway", "controlUi", "experimental", "chatBubbles"],
    },
    {
      ...BOOLEAN_GATE,
      id: "customPluginUi",
      docsUrl: "https://docs.openclaw.ai/plugins/feature-plugins",
      configPath: ["gateway", "controlUi", "experimental", "customPlugins"],
    },
    CLAWS_LAB_FEATURE,
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
