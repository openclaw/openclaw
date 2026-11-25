import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  currentConfigObject,
  currentDisplayConfig,
  type RuntimeConfigState,
} from "../../lib/config/config-state-model.ts";

/** Null until configuration arrives; only an explicit advanced opt-out disables it. */
export function isTemplatesAvailable(state: RuntimeConfigState): boolean | null {
  const config = currentDisplayConfig(state) ?? currentConfigObject(state);
  if (!config) {
    return null;
  }
  const gateway = config.gateway;
  const controlUi = isRecord(gateway) ? gateway.controlUi : undefined;
  const experimental = isRecord(controlUi) ? controlUi.experimental : undefined;
  return !isRecord(experimental) || experimental.templates !== false;
}
