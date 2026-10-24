import { BOOLEAN_GATE, type LabFeatureDefinition } from "./labs-feature-state.ts";

export const CLAWS_LAB_FEATURE = {
  ...BOOLEAN_GATE,
  id: "claws",
  docsUrl: "https://docs.openclaw.ai/cli/claws",
  configPath: ["gateway", "controlUi", "experimental", "claws"],
} as const satisfies LabFeatureDefinition;
