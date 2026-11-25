import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { normalizeCommandBody } from "../commands-registry-normalize.js";
import type { CommandNormalizeOptions } from "../commands-registry.types.js";
import { isAbortTrigger, normalizeAbortTriggerText } from "./abort-trigger-text.js";

const ABORT_MEMORY = resolveGlobalMap<string, boolean>(
  Symbol.for("openclaw.abortMemory"),
  "close-and-restart",
);
const ABORT_MEMORY_MAX = 2000;
export function isAbortRequestText(text?: string, options?: CommandNormalizeOptions): boolean {
  if (!text) {
    return false;
  }
  const normalized = normalizeCommandBody(text, options);
  return normalizeAbortTriggerText(normalized) === "/stop" || isAbortTrigger(normalized);
}

export function getAbortMemory(key: string): boolean | undefined {
  const normalized = key.trim();
  return normalized ? ABORT_MEMORY.get(normalized) : undefined;
}

export function setAbortMemory(key: string, value: boolean): void {
  const normalized = key.trim();
  if (!normalized) {
    return;
  }
  ABORT_MEMORY.delete(normalized);
  if (!value) {
    return;
  }
  ABORT_MEMORY.set(normalized, true);
  pruneMapToMaxSize(ABORT_MEMORY, ABORT_MEMORY_MAX);
}
