import type { SessionParticipant } from "../../../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { ApplicationGateway } from "../../../app/gateway.ts";

export type DetailsViewer = { pending: boolean; identity?: SessionParticipant["identity"] };

/** Read the admitted application snapshot; this adapter never requests identity. */
export function readDetailsViewer(
  self: ApplicationGateway["snapshot"]["selfUser"] | undefined,
  bound: boolean,
): DetailsViewer {
  return { pending: bound && self !== null && !self?.identity, identity: self?.identity };
}
