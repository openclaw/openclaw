import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";

export function describeResolvedContextEngineContractError(
  engineId: string,
  engine: unknown,
): string | null {
  const candidate = asOptionalObjectRecord(engine);
  if (!candidate) {
    return `Context engine "${engineId}" factory returned ${JSON.stringify(engine)} instead of a ContextEngine object.`;
  }

  const issues: string[] = [];
  const info = asOptionalObjectRecord(candidate.info);
  if (!info) {
    issues.push("missing info");
  } else {
    // Engines own their internal info.id; it is metadata, not a handle into the
    // registry. The registered id (plugin slot id) and the engine's own id are
    // allowed to differ, so we only require that info.id is a non-empty string
    // for display/logging purposes and do not enforce equality with engineId.
    for (const field of ["id", "name"]) {
      const value = info[field];
      if (typeof value !== "string" || !value.trim()) {
        issues.push(`missing info.${field}`);
      }
    }
  }

  for (const method of ["ingest", "assemble", "compact"]) {
    if (typeof candidate[method] !== "function") {
      issues.push(`missing ${method}()`);
    }
  }

  return issues.length === 0
    ? null
    : `Context engine "${engineId}" factory returned an invalid ContextEngine: ${issues.join(", ")}.`;
}
