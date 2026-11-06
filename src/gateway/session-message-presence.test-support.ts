import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export function findWatchedPresenceEntry(message: unknown, instanceId: string) {
  const frame = asOptionalRecord(message);
  if (frame?.event !== "presence") {
    return undefined;
  }
  const payload = asOptionalRecord(frame.payload);
  const presence = Array.isArray(payload?.presence) ? payload.presence : [];
  return presence.find(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) &&
      typeof entry === "object" &&
      asOptionalRecord(entry)?.instanceId === instanceId,
  );
}

export function getConnId(hello: unknown) {
  const connectionId = asOptionalRecord(asOptionalRecord(hello)?.server)?.connId;
  if (typeof connectionId !== "string") {
    throw new Error("observer connection ID is missing");
  }
  return connectionId;
}
