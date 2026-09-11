import type { GatewaySessionRow } from "../../api/types.ts";

/** Same-content merge detection; row values are wire scalars/plain objects, so one level suffices. */
export function isShallowEqualSessionRow(
  incoming: GatewaySessionRow,
  existing: GatewaySessionRow,
): boolean {
  const incomingFields: Record<string, unknown> = incoming;
  const existingFields: Record<string, unknown> = existing;
  const incomingKeys = Object.keys(incoming);
  if (incomingKeys.length !== Object.keys(existing).length) {
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
