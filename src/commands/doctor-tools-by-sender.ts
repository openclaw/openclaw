import type { OpenClawConfig } from "../config/config.js";
import { parseToolsBySenderTypedKey } from "../config/types.tools.js";
import { formatConfigPath, resolveConfigPathTarget } from "./doctor-config-analysis.js";

export type LegacyToolsBySenderKeyHit = {
  toolsBySenderPath: Array<string | number>;
  pathLabel: string;
  key: string;
  targetKey: string;
};

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function collectLegacyToolsBySenderKeyHits(
  value: unknown,
  pathParts: Array<string | number>,
  hits: LegacyToolsBySenderKeyHit[],
) {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      collectLegacyToolsBySenderKeyHits(entry, [...pathParts, index], hits);
    }
    return;
  }
  const record = asObjectRecord(value);
  if (!record) {
    return;
  }

  const toolsBySender = asObjectRecord(record.toolsBySender);
  if (toolsBySender) {
    const path = [...pathParts, "toolsBySender"];
    const pathLabel = formatConfigPath(path);
    for (const rawKey of Object.keys(toolsBySender)) {
      const trimmed = rawKey.trim();
      if (!trimmed || trimmed === "*" || parseToolsBySenderTypedKey(trimmed)) {
        continue;
      }
      hits.push({
        toolsBySenderPath: path,
        pathLabel,
        key: rawKey,
        targetKey: `id:${trimmed}`,
      });
    }
  }

  for (const [key, nested] of Object.entries(record)) {
    if (key === "toolsBySender") {
      continue;
    }
    collectLegacyToolsBySenderKeyHits(nested, [...pathParts, key], hits);
  }
}

export function scanLegacyToolsBySenderKeys(cfg: OpenClawConfig): LegacyToolsBySenderKeyHit[] {
  const hits: LegacyToolsBySenderKeyHit[] = [];
  collectLegacyToolsBySenderKeyHits(cfg, [], hits);
  return hits;
}

export function maybeRepairLegacyToolsBySenderKeys(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const next = structuredClone(cfg);
  const hits = scanLegacyToolsBySenderKeys(next);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const summary = new Map<
    string,
    { migrated: number; dropped: number; migratedExamples: string[]; droppedExamples: string[] }
  >();
  let changed = false;

  for (const hit of hits) {
    const toolsBySender = asObjectRecord(resolveConfigPathTarget(next, hit.toolsBySenderPath));
    if (!toolsBySender || !(hit.key in toolsBySender)) {
      continue;
    }
    const row = summary.get(hit.pathLabel) ?? {
      migrated: 0,
      dropped: 0,
      migratedExamples: [],
      droppedExamples: [],
    };

    if (toolsBySender[hit.targetKey] === undefined) {
      toolsBySender[hit.targetKey] = toolsBySender[hit.key];
      row.migrated++;
      if (row.migratedExamples.length < 3) {
        row.migratedExamples.push(`${hit.key} -> ${hit.targetKey}`);
      }
    } else {
      row.dropped++;
      if (row.droppedExamples.length < 3) {
        row.droppedExamples.push(`${hit.key} (kept existing ${hit.targetKey})`);
      }
    }
    delete toolsBySender[hit.key];
    summary.set(hit.pathLabel, row);
    changed = true;
  }

  if (!changed) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  for (const [pathLabel, row] of summary) {
    if (row.migrated > 0) {
      const suffix = row.migratedExamples.length > 0 ? ` (${row.migratedExamples.join(", ")})` : "";
      changes.push(
        `- ${pathLabel}: migrated ${row.migrated} legacy key${row.migrated === 1 ? "" : "s"} to typed id: entries${suffix}.`,
      );
    }
    if (row.dropped > 0) {
      const suffix = row.droppedExamples.length > 0 ? ` (${row.droppedExamples.join(", ")})` : "";
      changes.push(
        `- ${pathLabel}: removed ${row.dropped} legacy key${row.dropped === 1 ? "" : "s"} where typed id: entries already existed${suffix}.`,
      );
    }
  }

  return { config: next, changes };
}
