import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import { asObjectRecord } from "./object.js";

export type LegacyMemorySlotHit = {
  pathLabel: string;
  legacyValue: string;
  recallValue?: string;
  conflict: boolean;
};

function ownSlot(slots: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(slots, key);
}

function normalizeSlotText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function collectSlotHit(params: {
  slots: Record<string, unknown>;
  pathLabel: string;
}): LegacyMemorySlotHit | undefined {
  if (!ownSlot(params.slots, "memory")) {
    return undefined;
  }
  const legacyValue = normalizeSlotText(params.slots.memory);
  if (!legacyValue) {
    return {
      pathLabel: `${params.pathLabel}.memory`,
      legacyValue: "",
      conflict: false,
    };
  }
  const recallValue = ownSlot(params.slots, "memory.recall")
    ? normalizeSlotText(params.slots["memory.recall"])
    : undefined;
  return {
    pathLabel: `${params.pathLabel}.memory`,
    legacyValue,
    recallValue,
    conflict: recallValue !== undefined && recallValue !== legacyValue,
  };
}

export function scanLegacyMemorySlotConfig(cfg: OpenClawConfig): LegacyMemorySlotHit[] {
  const hits: LegacyMemorySlotHit[] = [];
  const globalSlots = asObjectRecord(cfg.plugins?.slots);
  if (globalSlots) {
    const hit = collectSlotHit({
      slots: globalSlots,
      pathLabel: "plugins.slots",
    });
    if (hit) {
      hits.push(hit);
    }
  }

  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    const agentRecord = asObjectRecord(agent);
    const plugins = asObjectRecord(agentRecord?.plugins);
    const slots = asObjectRecord(plugins?.slots);
    if (!slots) {
      continue;
    }
    const hit = collectSlotHit({
      slots,
      pathLabel: `agents.list.${index}.plugins.slots`,
    });
    if (hit) {
      hits.push(hit);
    }
  }

  return hits;
}

export function collectLegacyMemorySlotWarnings(params: {
  hits: readonly LegacyMemorySlotHit[];
  doctorFixCommand: string;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }
  const conflicts = params.hits.filter((hit) => hit.conflict);
  const fixableCount = params.hits.length - conflicts.length;
  const sample = sanitizeForLog(params.hits[0]?.pathLabel ?? "plugins.slots.memory");
  const warnings = [
    `- Found ${params.hits.length} legacy memory slot selector${params.hits.length === 1 ? "" : "s"} (for example ${sample}).`,
    '- `plugins.slots.memory` is deprecated; use `plugins.slots["memory.recall"]` for factual recall provider selection.',
    "- Doctor keeps non-conflicting legacy memory selectors in place for plugin compatibility during the extended migration window.",
  ];
  if (fixableCount > 0) {
    warnings.push(
      `- Run "${params.doctorFixCommand}" to migrate ${fixableCount} non-conflicting legacy memory slot${fixableCount === 1 ? "" : "s"}.`,
    );
  }
  if (conflicts.length > 0) {
    warnings.push(
      `- ${conflicts.length} legacy memory slot${conflicts.length === 1 ? " also defines" : "s also define"} a different memory.recall value; resolve ${conflicts.length === 1 ? "it" : "those"} manually so doctor does not guess.`,
    );
  }
  return warnings;
}

function migrateSlots(params: {
  slots: Record<string, unknown>;
  hit: LegacyMemorySlotHit;
}): "migrated" | "preserved" | "removed-empty" | "skipped-conflict" | "unchanged" {
  if (!ownSlot(params.slots, "memory")) {
    return "unchanged";
  }
  if (params.hit.conflict) {
    return "skipped-conflict";
  }
  if (params.hit.legacyValue) {
    if (params.hit.recallValue === params.hit.legacyValue) {
      return "preserved";
    }
    params.slots["memory.recall"] = params.hit.legacyValue;
    return "migrated";
  }
  delete params.slots.memory;
  return "removed-empty";
}

export function maybeRepairLegacyMemorySlotConfig(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
  warnings?: string[];
} {
  const hits = scanLegacyMemorySlotConfig(cfg);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes: string[] = [];
  const warnings: string[] = [];

  const applyHit = (
    hit: LegacyMemorySlotHit,
    slots: Record<string, unknown> | null | undefined,
  ) => {
    if (!slots) {
      return;
    }
    const result = migrateSlots({ slots, hit });
    if (result === "migrated") {
      changes.push(
        `- ${hit.pathLabel}: copied legacy memory slot to memory.recall (${hit.legacyValue}) and kept the legacy key for plugin compatibility.`,
      );
      warnings.push(
        `- ${hit.pathLabel}: legacy memory slot remains for plugin compatibility; use memory.recall as the canonical selector.`,
      );
    } else if (result === "preserved") {
      warnings.push(
        `- ${hit.pathLabel}: legacy memory slot already matches memory.recall and remains for plugin compatibility.`,
      );
    } else if (result === "removed-empty") {
      changes.push(`- ${hit.pathLabel}: removed empty legacy memory slot selector.`);
    } else if (result === "skipped-conflict") {
      warnings.push(
        `- ${hit.pathLabel}: kept legacy memory slot because memory.recall is already "${hit.recallValue}" while memory is "${hit.legacyValue}".`,
      );
    }
  };

  const globalHit = hits.find((hit) => hit.pathLabel === "plugins.slots.memory");
  if (globalHit) {
    applyHit(globalHit, asObjectRecord(next.plugins?.slots));
  }

  const agents = Array.isArray(next.agents?.list) ? next.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    const hit = hits.find(
      (candidate) => candidate.pathLabel === `agents.list.${index}.plugins.slots.memory`,
    );
    if (!hit) {
      continue;
    }
    const agentRecord = asObjectRecord(agent);
    const plugins = asObjectRecord(agentRecord?.plugins);
    applyHit(hit, asObjectRecord(plugins?.slots));
  }

  return {
    config: changes.length > 0 ? next : cfg,
    changes: changes.map((change) => sanitizeForLog(change)),
    ...(warnings.length > 0
      ? { warnings: warnings.map((warning) => sanitizeForLog(warning)) }
      : {}),
  };
}
