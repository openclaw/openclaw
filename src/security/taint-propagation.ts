/**
 * IBEL Phase 1 — Taint derivation from multiple sources.
 *
 * When an artifact is constructed from multiple tagged payloads,
 * the result inherits the worst-case taint across all sources.
 */

import { worstCaseLevel } from "./instruction-level.js";
import { InstructionLevel } from "./types.js";
import type { TaggedPayload, TaintField } from "./types.js";

/**
 * Derive a combined taint from multiple source payloads.
 * Returns a TaggedPayload with:
 * - level: worst-case across all sources
 * - fields: merged (worst-case per field path), omitted if any source lacks fields
 */
export function deriveTaint(sources: TaggedPayload[]): TaggedPayload {
  if (sources.length === 0) {
    return { level: InstructionLevel.SYSTEM, content: undefined };
  }

  const level = worstCaseLevel(...sources.map((s) => s.level));

  // If any source lacks field-level taint, we can't provide field granularity.
  const allHaveFields = sources.every((s) => s.fields != null);

  let fields: TaintField[] | undefined;
  if (allHaveFields) {
    const merged = new Map<string, TaintField>();
    for (const source of sources) {
      for (const field of source.fields!) {
        const existing = merged.get(field.fieldPath);
        if (!existing || field.level > existing.level) {
          merged.set(field.fieldPath, { ...field });
        }
      }
    }
    fields = [...merged.values()];
  }

  return { level, content: undefined, fields };
}
