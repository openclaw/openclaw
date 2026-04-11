import type { OutboundSendDeps } from "../infra/outbound/send-deps.js";
import type { CliDeps } from "./deps.types.js";
import { createOutboundSendDepsFromCliSource } from "./outbound-send-mapping.js";

export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return createOutboundSendDepsFromCliSource(deps);
}
