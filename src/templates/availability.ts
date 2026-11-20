import type { OpenClawConfig } from "../config/types.openclaw.js";

export const TEMPLATES_DISABLED_MESSAGE =
  "Templates are disabled by gateway.controlUi.experimental.templates. Ask the Gateway administrator to enable Templates.";

export class TemplatesDisabledError extends Error {
  constructor() {
    super(TEMPLATES_DISABLED_MESSAGE);
    this.name = "TemplatesDisabledError";
  }
}

export function isTemplatesEnabled(config: OpenClawConfig): boolean {
  return config.gateway?.controlUi?.experimental?.templates !== false;
}

export function assertTemplatesEnabled(config: OpenClawConfig): void {
  if (!isTemplatesEnabled(config)) {
    throw new TemplatesDisabledError();
  }
}
