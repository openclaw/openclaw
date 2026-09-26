// Normalizes abort command primitives before runtime cancellation.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
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
  const normalized = normalizeCommandBody(text, options).trim();
  if (!normalized) {
    return false;
  }
  const normalizedLower = normalizeLowercaseStringOrEmpty(normalized);
  return (
    normalizedLower === "/stop" ||
    normalizeAbortTriggerText(normalizedLower) === "/stop" ||
    isAbortTrigger(normalizedLower)
  );
}

export function getAbortMemory(key: string): boolean | undefined {
  const normalized = key.trim();
  if (!normalized) {
    return undefined;
  }
  return ABORT_MEMORY.get(normalized);
}

export function setAbortMemory(key: string, value: boolean): void {
  const normalized = key.trim();
  if (!normalized) {
    return;
  }
  if (!value) {
    ABORT_MEMORY.delete(normalized);
    return;
  }
  if (ABORT_MEMORY.has(normalized)) {
    ABORT_MEMORY.delete(normalized);
  }
  ABORT_MEMORY.set(normalized, true);
  pruneMapToMaxSize(ABORT_MEMORY, ABORT_MEMORY_MAX);
}
