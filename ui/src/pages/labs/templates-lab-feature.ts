import { BOOLEAN_GATE, type LabFeatureDefinition } from "./labs-feature-state.ts";

export const TEMPLATES_LAB_FEATURE = {
  ...BOOLEAN_GATE,
  id: "templates",
  configPath: ["gateway", "controlUi", "experimental", "templates"],
} as const satisfies LabFeatureDefinition;
