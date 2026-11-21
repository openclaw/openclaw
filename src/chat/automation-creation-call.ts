import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Keep call admission independent of the deferred saved-result interpreter. */
export function automationCreationCall(value: unknown) {
  const args = asOptionalRecord(value);
  if (args?.action === "plan") {
    return { action: "plan" as const };
  }
  if (args?.action === "add" && args.planId === undefined && args.slotId === undefined) {
    return {
      action: "add" as const,
      ...(typeof args.position === "number" ? { position: args.position } : {}),
    };
  }
  if (
    args?.action === "add" &&
    typeof args.planId === "string" &&
    args.planId.length <= 1024 &&
    typeof args.slotId === "string" &&
    args.slotId.length <= 64
  ) {
    return { action: "add" as const, planId: args.planId, slotId: args.slotId };
  }
  return undefined;
}
