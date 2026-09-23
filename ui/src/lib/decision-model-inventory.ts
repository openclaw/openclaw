import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { DecisionModelEntry } from "../components/decision-model-picker.ts";

export type DecisionModelUse = { agentId?: string; taskId?: string };
export type DecisionInventoryEntry = {
  ref: string;
  name: string;
  available: boolean;
  uses: DecisionModelUse[];
};

export function readDecisionModelInventory(
  config: Record<string, unknown> | null,
  available: readonly DecisionModelEntry[],
): DecisionInventoryEntry[] {
  const refs = new Map<string, DecisionModelUse[]>();
  const add = (value: unknown, use?: DecisionModelUse) => {
    if (typeof value !== "string" || !value.trim()) {
      return;
    }
    const ref = value.trim();
    const uses = refs.get(ref) ?? [];
    if (use) {
      uses.push(use);
    }
    refs.set(ref, uses);
  };
  const explicit = asRecord(config?.models)?.decisionModels;
  if (Array.isArray(explicit)) {
    explicit.forEach((ref) => add(ref));
  }
  const agents = asRecord(config?.agents);
  const visit = (value: unknown, agentId?: string) => {
    const entry = asRecord(value);
    add(entry?.decisionModel, { agentId });
    for (const [taskId, model] of Object.entries(asRecord(entry?.decisionModelsByTask) ?? {})) {
      add(model, { agentId, taskId });
    }
  };
  visit(agents?.defaults);
  for (const [agentId, entry] of Object.entries(asRecord(agents?.entries) ?? {})) {
    visit(entry, agentId);
  }
  return [...refs].map(([ref, uses]) => {
    const model = available.find((candidate) => `${candidate.provider}/${candidate.id}` === ref);
    return { ref, name: model?.name ?? ref, available: Boolean(model), uses };
  });
}

/** Replace all saved uses and the inventory in one merge patch; empty disables stay untouched. */
export function decisionModelRemovalPatch(
  inventory: readonly DecisionInventoryEntry[],
  ref: string,
  replacement: string,
): Record<string, unknown> | null {
  const removed = inventory.find((model) => model.ref === ref);
  if (!removed) {
    return null;
  }
  if (
    removed.uses.length > 0 &&
    !inventory.some((model) => model.ref === replacement && model.ref !== ref && model.available)
  ) {
    return null;
  }
  const patch: Record<string, unknown> = {
    models: {
      decisionModels: inventory.filter((model) => model.ref !== ref).map((model) => model.ref),
    },
  };
  const agentEntries = new Map<string, Record<string, unknown>>();
  for (const use of removed.uses) {
    const key = use.agentId === undefined ? "" : use.agentId;
    const entry = agentEntries.get(key) ?? {};
    if (use.taskId) {
      entry.decisionModelsByTask = {
        ...asRecord(entry.decisionModelsByTask),
        [use.taskId]: replacement,
      };
    } else {
      entry.decisionModel = replacement;
    }
    agentEntries.set(key, entry);
  }
  if (agentEntries.size > 0) {
    patch.agents = {
      ...(agentEntries.has("") ? { defaults: agentEntries.get("") } : {}),
      entries: Object.fromEntries([...agentEntries].filter(([key]) => key !== "")),
    };
  }
  return patch;
}
