import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isCanonicalSessionDeliveryState } from "../../utils/delivery-context.shared.js";

export function assertSupportedSessionStoreEntry(entry: unknown): void {
  if (!isRecord(entry)) {
    return;
  }
  const canonicalDelivery = isCanonicalSessionDeliveryState(entry.delivery);
  const retiredField = (
    [
      ["provider", "channel"],
      ["lastProvider", "lastChannel"],
      ["room", "groupChannel"],
    ] as const
  ).find(
    ([legacy, current]) =>
      typeof entry[legacy] === "string" &&
      typeof entry[current] !== "string" &&
      (legacy === "room" || !canonicalDelivery),
  )?.[0];
  if (retiredField) {
    throw new Error(
      `Session field "${retiredField}" predates July 2026 and is no longer supported. Preserve the original store and use an older OpenClaw release to migrate it before upgrading.`,
    );
  }
}
