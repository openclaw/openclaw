import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";

/** The original ingress row is the sole source of input for a first dispatch. */
export function readUndispatchedChannelText(
  message: unknown,
  sourceTurnId: string,
): string | undefined {
  const source = asOptionalObjectRecord(message);
  const meta = asOptionalObjectRecord(source?.["__openclaw"]);
  if (
    source?.role !== "user" ||
    source.idempotencyKey !== sourceTurnId ||
    source.display === false ||
    source.excludeFromContext === true ||
    (source.provenance !== undefined &&
      asOptionalObjectRecord(source.provenance)?.kind !== "external_user") ||
    meta?.media ||
    meta?.mediaImageLayout ||
    meta?.lateMedia ||
    meta?.steerTargetRunId
  ) {
    return undefined;
  }
  const content = source.content;
  if (typeof content === "string" && content.trim()) {
    return content;
  }
  return undefined;
}
