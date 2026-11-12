import { resolveSessionCreationVisibility } from "../config/sessions/creation-visibility.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function resolvePatchCreationVisibility(params: {
  cfg: OpenClawConfig;
  storeKey: string;
  existingEntry?: SessionEntry;
  attendedProfileOperator?: boolean;
}) {
  return params.existingEntry === undefined
    ? resolveSessionCreationVisibility(params.cfg, params.storeKey, undefined, {
        attendedProfileOperator: params.attendedProfileOperator,
      })
    : {};
}
