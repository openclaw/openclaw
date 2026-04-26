import type { JsonValue, TaskFlowRecord } from "./task-flow-registry.types.js";

export function isJsonObject(
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function getFlowResidueResolution(flow: TaskFlowRecord): Record<string, JsonValue> | null {
  const state = flow.stateJson;
  if (!isJsonObject(state)) {
    return null;
  }
  const residue = state.residueResolution;
  return isJsonObject(residue) ? residue : null;
}

export function mergeFlowStateJson(
  current: JsonValue | null | undefined,
  patch: Record<string, JsonValue | null | undefined>,
): JsonValue {
  const base: Record<string, JsonValue> = isJsonObject(current) ? { ...current } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete base[key];
    } else {
      base[key] = value;
    }
  }
  return base;
}
