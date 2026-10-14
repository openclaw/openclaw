import type { GatewaySessionRow } from "../../api/types.ts";

/** Compare presentation values without treating read freshness as a content change. */
export function isShallowEqualSessionRow(
  incoming: GatewaySessionRow,
  existing: GatewaySessionRow,
): boolean {
  const incomingFields: Record<string, unknown> = incoming;
  const existingFields: Record<string, unknown> = existing;
  const incomingKeys = Object.keys(incoming).filter((key) => key !== "snapshotAt");
  const existingKeys = Object.keys(existing).filter((key) => key !== "snapshotAt");
  if (incomingKeys.length !== existingKeys.length) {
    return false;
  }
  return incomingKeys.every((key) => {
    const a = incomingFields[key];
    const b = existingFields[key];
    return (
      a === b ||
      (a !== null && b !== null && typeof a === "object" && typeof b === "object"
        ? JSON.stringify(a) === JSON.stringify(b)
        : false)
    );
  });
}
