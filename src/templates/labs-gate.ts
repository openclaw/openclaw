import type { OpenClawConfig } from "../config/types.openclaw.js";

export const TEMPLATES_LABS_DISABLED_MESSAGE =
  "Templates is off in Settings > Labs. Turn it on to discover or add Templates.";

export class TemplatesLabsDisabledError extends Error {
  constructor() {
    super(TEMPLATES_LABS_DISABLED_MESSAGE);
    this.name = "TemplatesLabsDisabledError";
  }
}

export function isTemplatesLabsEnabled(config: OpenClawConfig): boolean {
  return config.gateway?.controlUi?.experimental?.templates === true;
}

export function assertTemplatesLabsEnabled(config: OpenClawConfig): void {
  if (!isTemplatesLabsEnabled(config)) {
    throw new TemplatesLabsDisabledError();
  }
}
