import type { OpenClawConfig } from "../config/types.openclaw.js";

export const CLAWS_LABS_DISABLED_MESSAGE =
  "Claws is off in Settings > Labs. Turn it on to discover, add, or update Claws.";

export class ClawsLabsDisabledError extends Error {
  constructor() {
    super(CLAWS_LABS_DISABLED_MESSAGE);
    this.name = "ClawsLabsDisabledError";
  }
}

export function isClawsLabsEnabled(config: OpenClawConfig): boolean {
  return config.gateway?.controlUi?.experimental?.claws === true;
}

export function assertClawsLabsEnabled(config: OpenClawConfig): void {
  if (!isClawsLabsEnabled(config)) {
    throw new ClawsLabsDisabledError();
  }
}
