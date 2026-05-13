export type DeliveryQueueEntryJsonRow = {
  entry_json: string;
};

export function isDeliveryQueueEntryWithId(
  value: unknown,
): value is Record<string, unknown> & { id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("id" in value)) {
    return false;
  }
  return typeof value.id === "string";
}

export function parseDeliveryQueueEntryJson<Entry>(
  row: DeliveryQueueEntryJsonRow | undefined,
  isEntry: (value: unknown) => value is Entry,
): Entry | null {
  if (!row) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.entry_json) as unknown;
  } catch {
    return null;
  }
  return isEntry(parsed) ? parsed : null;
}
