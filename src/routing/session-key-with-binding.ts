/**
 * Thread-binding-aware session key resolution.
 * This module is server-only and should not be imported by browser code.
 */

import {
  buildThreadKey,
  getThreadRegistry,
  type ThreadBinding,
} from "../config/thread-registry.js";
import { resolveThreadSessionKeys } from "./session-key.js";

/**
 * Resolve session key with thread-binding registry check.
 *
 * Priority:
 * 1. Check the in-memory registry for explicit bindings (O(1) lookup).
 * 2. Fall back to the existing `resolveThreadSessionKeys()` suffix logic.
 *
 * **Server-only**: This function requires the thread-registry, which is not available in browsers.
 */
export function resolveSessionKeyWithBinding(params: {
  baseSessionKey: string;
  channel?: string;
  accountId?: string;
  threadId?: string | null;
  parentSessionKey?: string;
  useSuffix?: boolean;
}): {
  sessionKey: string;
  boundSessions?: string[];
  parentSessionKey?: string;
  threadBinding?: ThreadBinding;
} {
  const { baseSessionKey, channel, accountId, threadId, useSuffix } = params;
  const trimmedThreadId = (threadId ?? "").trim();

  // If no threadId, skip registry lookup entirely.
  if (!trimmedThreadId || !channel) {
    return { sessionKey: baseSessionKey };
  }

  // Registry check (O(1))
  const threadKey = buildThreadKey({ channel, accountId, threadId: trimmedThreadId });
  const registry = getThreadRegistry();
  const boundSessions = registry.lookup(threadKey);

  if (boundSessions.length > 0) {
    const primaryKey = boundSessions[0];
    const binding = registry.getBindingData(primaryKey);
    return {
      sessionKey: primaryKey, // Primary bound session
      boundSessions,
      threadBinding: binding,
    };
  }

  // Fall back to computed suffix logic
  return resolveThreadSessionKeys({
    baseSessionKey,
    threadId: trimmedThreadId,
    parentSessionKey: params.parentSessionKey,
    useSuffix,
  });
}
