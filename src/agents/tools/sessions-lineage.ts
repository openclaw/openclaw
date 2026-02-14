import {
  getRunByChildKey,
  listAllSubagentRuns,
  listSubagentRunsForRequester,
} from "../subagent-registry.js";

export function getAncestors(sessionKey: string): string[] {
  const ancestors: string[] = [];
  let current = sessionKey;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    const record = getRunByChildKey(current);
    if (!record?.requesterSessionKey) {
      break;
    }
    ancestors.push(record.requesterSessionKey);
    current = record.requesterSessionKey;
  }
  return ancestors;
}

export function getDescendants(sessionKey: string): string[] {
  const descendants: string[] = [];
  const queue = [sessionKey];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    // Prefer childKeys from run metadata when present.
    const record = getRunByChildKey(current);
    const childKeys = record?.childKeys;
    if (childKeys && childKeys.size > 0) {
      for (const child of childKeys) {
        descendants.push(child);
        queue.push(child);
      }
      continue;
    }

    // Root session (no record) or missing childKeys metadata: scan by requester key.
    const directChildren = listSubagentRunsForRequester(current);
    const scannedChildren =
      directChildren.length > 0
        ? directChildren
        : listAllSubagentRuns().filter((run) => run.requesterSessionKey === current);
    for (const childRun of scannedChildren) {
      if (!seen.has(childRun.childSessionKey)) {
        descendants.push(childRun.childSessionKey);
        queue.push(childRun.childSessionKey);
      }
    }
  }
  return descendants;
}

export function isInLineage(callerKey: string, targetKey: string): boolean {
  if (callerKey === targetKey) {
    return true;
  }
  const ancestors = getAncestors(callerKey);
  if (ancestors.includes(targetKey)) {
    return true;
  }
  const descendants = getDescendants(callerKey);
  if (descendants.includes(targetKey)) {
    return true;
  }
  return false;
}

export function isAncestor(callerKey: string, targetKey: string): boolean {
  const ancestors = getAncestors(targetKey);
  return ancestors.includes(callerKey);
}

export function getSubtreeLeafFirst(sessionKey: string): string[] {
  const all = getDescendants(sessionKey);
  return [...all.reverse(), sessionKey];
}
