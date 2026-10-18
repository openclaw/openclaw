/** Preserve own navigation fields, including malformed controls, without retaining payloads. */
export function projectTranscriptNavigationFields(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const navigation: Record<string, unknown> = {};
  for (const key of ["type", "id", "parentId", "targetId", "appendParentId", "appendMode"]) {
    if (Object.hasOwn(record, key)) {
      navigation[key] = record[key];
    }
  }
  return navigation;
}
