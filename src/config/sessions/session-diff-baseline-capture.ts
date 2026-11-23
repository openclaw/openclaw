import { randomUUID } from "node:crypto";
import { buildSessionCreationStamp } from "./session-entry-provenance.js";

export type SessionDiffBaselineCapture = {
  version: 1;
  captureId: string;
  status: "pending" | "unavailable";
};

export function createSessionDiffBaselineCaptureClaim(): SessionDiffBaselineCapture {
  return { version: 1, captureId: randomUUID(), status: "pending" };
}

/** New-row fields; an operator conversation also claims its pre-session diff baseline. */
export function buildNewSessionCreationFields(
  params: Parameters<typeof buildSessionCreationStamp>[0],
) {
  const stamp = buildSessionCreationStamp(params);
  return params.via === "operator"
    ? { ...stamp, sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim() }
    : stamp;
}
