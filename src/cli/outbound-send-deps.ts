import type { OutboundSendDeps } from "../infra/outbound/deliver.js";
import {
  createOutboundSendDepsFromCliSource,
  type CliOutboundSendSource,
} from "./outbound-send-mapping.js";

export type CliDeps = Required<CliOutboundSendSource>;

export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return createOutboundSendDepsFromCliSource(deps);
}
