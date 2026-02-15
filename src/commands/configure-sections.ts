// Extracted to a standalone module so the CLI registration file can import
// the section list without pulling in @clack/prompts (which configure.shared.ts uses).
export const CONFIGURE_WIZARD_SECTIONS = [
  "workspace",
  "model",
  "web",
  "gateway",
  "daemon",
  "channels",
  "skills",
  "health",
] as const;

export type WizardSection = (typeof CONFIGURE_WIZARD_SECTIONS)[number];
