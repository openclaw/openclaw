import { expect } from "vitest";
import { listSessionBranches } from "./session-accessor.js";
import type { SessionBranchSummary } from "./session-accessor.types.js";

export function branchMessage(
  id: string,
  parentId: string | null,
  content: unknown,
  options: { role?: string; phase?: string; appendMode?: string; timestamp?: string } = {},
): Record<string, unknown> {
  const { role = "user", phase, ...eventFields } = options;
  return {
    type: "message",
    id,
    parentId,
    message: { role, content, ...(phase ? { phase } : {}) },
    ...eventFields,
  };
}

export function branchSummary(
  leafEntryId: string,
  headline: string,
  messageCount: number,
  active = false,
  updatedAt?: string,
): SessionBranchSummary {
  return {
    leafEntryId,
    headline,
    messageCount,
    active,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

export function expectBranchList(
  scope: Parameters<typeof listSessionBranches>[0],
  branches: SessionBranchSummary[],
) {
  return expect(listSessionBranches(scope)).resolves.toEqual({ status: "ok", branches });
}
