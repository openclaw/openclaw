// HTTP/CSP paths need the setting without loading the terminal launch policy.
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function isTerminalConfigEnabled(config: OpenClawConfig | undefined): boolean {
  return config?.gateway?.terminal?.enabled !== false;
}
