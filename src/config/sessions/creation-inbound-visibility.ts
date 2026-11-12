import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveSessionCreationVisibility } from "./creation-visibility.js";

export function inboundCreationVisibility(
  cfg: OpenClawConfig,
  sessionKey: string,
  creation: MsgContext["SessionCreation"],
) {
  return resolveSessionCreationVisibility(cfg, sessionKey, undefined, {
    attendedProfileOperator:
      creation?.attendedProfileOperator === true &&
      creation.via === "operator" &&
      creation.actor?.type === "human" &&
      creation.actor.source === "profile",
  });
}
