import { buildAgentMainSessionKey } from "../../routing/session-key.js";
import type { SessionScope } from "./types.js";

/** Resolves the configured main session identity for one agent and session scope. */
export function resolveCanonicalMainSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
  sessionScope?: SessionScope;
}): string {
  return params.sessionScope === "global" ? "global" : buildAgentMainSessionKey(params);
}

/** Preserve canonical-first lookup order while checking requested and legacy main aliases. */
export function collectCanonicalSessionLookupKeys(params: {
  agentId: string;
  canonicalKey: string;
  requestedKey: string;
  mainKey?: string;
}): string[] {
  const targets = new Set<string>();
  if (params.canonicalKey) {
    targets.add(params.canonicalKey);
  }
  if (params.requestedKey && params.requestedKey !== params.canonicalKey) {
    targets.add(params.requestedKey);
  }
  if (params.canonicalKey === "global" || params.canonicalKey === "unknown") {
    return [...targets];
  }
  if (params.canonicalKey === buildAgentMainSessionKey(params)) {
    targets.add(`agent:${params.agentId}:main`);
  }
  return [...targets];
}
