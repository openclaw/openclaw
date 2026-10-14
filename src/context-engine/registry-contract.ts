import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { ContextEngine } from "./types.js";

export const CONTEXT_ENGINE_HOST_PARAMS = new Set(
  "sessionKey prompt runtimeSettings sessionTarget runtimeContext abortSignal".split(" "),
);

export function projectContextEngineHostParams(
  engine: ContextEngine,
  methodName: PropertyKey,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const accepted = engine.info.acceptedHostParams;
  if (!accepted) {
    return params;
  }
  return Object.fromEntries(
    Object.entries(params).filter(
      ([key]) =>
        accepted.includes(key) ||
        !CONTEXT_ENGINE_HOST_PARAMS.has(key) ||
        (methodName === "compact" && key === "abortSignal"),
    ),
  );
}

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
