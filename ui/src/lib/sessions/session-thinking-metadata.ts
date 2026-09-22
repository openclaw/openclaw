export type ThinkingMetadataCarrier = {
  modelProvider?: string | null;
  model?: string | null;
  agentRuntime?: { id: string } | null;
  thinkingLevels?: Array<{ id: string; label: string }>;
  thinkingOptions?: string[];
  thinkingDefault?: string;
};

export const thinkingMetadataFields = [
  "thinkingLevels",
  "thinkingOptions",
  "thinkingDefault",
] as const;

export function thinkingMetadataIdentityMatches(
  incoming: ThinkingMetadataCarrier,
  existing: ThinkingMetadataCarrier,
): boolean {
  const incomingRuntime = incoming.agentRuntime?.id?.trim();
  const existingRuntime = existing.agentRuntime?.id?.trim();
  // Provider profiles can differ by runtime for the same model.
  return !(
    (incoming.modelProvider &&
      existing.modelProvider &&
      incoming.modelProvider !== existing.modelProvider) ||
    (incoming.model && existing.model && incoming.model !== existing.model) ||
    (incomingRuntime && existingRuntime && incomingRuntime !== existingRuntime)
  );
}

export function preserveOmittedThinkingMetadata<T extends ThinkingMetadataCarrier>(
  incoming: T,
  existing: ThinkingMetadataCarrier | undefined,
): T {
  // Prepared profiles are authoritative; omission means the catalog was unavailable.
  if (
    !existing ||
    (existing.thinkingLevels === undefined && existing.thinkingOptions === undefined) ||
    !thinkingMetadataIdentityMatches(incoming, existing) ||
    incoming.thinkingLevels !== undefined ||
    incoming.thinkingOptions !== undefined
  ) {
    return incoming;
  }
  return {
    ...incoming,
    ...(existing.thinkingLevels !== undefined ? { thinkingLevels: existing.thinkingLevels } : {}),
    ...(existing.thinkingOptions !== undefined
      ? { thinkingOptions: existing.thinkingOptions }
      : {}),
    ...(incoming.thinkingDefault === undefined && existing.thinkingDefault !== undefined
      ? { thinkingDefault: existing.thinkingDefault }
      : {}),
  };
}

export function stripThinkingMetadata<T extends ThinkingMetadataCarrier>(value: T): T {
  const next = { ...value };
  for (const field of thinkingMetadataFields) {
    delete next[field];
  }
  return next;
}
