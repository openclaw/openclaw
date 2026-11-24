import type { OpenClawConfig } from "../config/types.openclaw.js";

export const TEMPLATES_DISABLED_MESSAGE =
  "Templates is disabled in Gateway configuration. Set gateway.controlUi.experimental.templates to true or remove the override to discover or add Templates.";

export class TemplatesDisabledError extends Error {
  constructor() {
    super(TEMPLATES_DISABLED_MESSAGE);
    this.name = "TemplatesDisabledError";
  }
}

export function isTemplatesEnabled(config: OpenClawConfig): boolean {
  // Retain the shipped opt-out without requiring a Labs opt-in on upgrade.
  return config.gateway?.controlUi?.experimental?.templates !== false;
}

export function assertTemplatesEnabled(config: OpenClawConfig): void {
  if (!isTemplatesEnabled(config)) {
    throw new TemplatesDisabledError();
  }
}
