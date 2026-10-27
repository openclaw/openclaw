import type { OutboundSendDeps } from "../infra/outbound/send-deps.js";
import type { CliDeps } from "./deps.types.js";

export type { CliDeps } from "./deps.types.js";

export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  // Enumerate explicit transports only; proxy-generated CLI senders re-enter the adapter.
  return { ...deps };
}
