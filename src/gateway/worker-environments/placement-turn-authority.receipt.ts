import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type { ClaimChange, WorkspaceResultPostimage } from "./placement-turn-authority.types.js";

export function captureWorkspaceResultPostimage(
  sessionId: string,
  facts?: WorkspaceResultPostimage,
): WorkspaceResultPostimage | undefined {
  if (
    facts &&
    (facts.placement.sessionId !== sessionId ||
      (facts.pendingResult && facts.pendingResult.sessionId !== sessionId))
  ) {
    throw new Error("Workspace result publication has a different session owner");
  }
  return freezeJsonSnapshot(facts);
}

export function captureWorkspaceResultChange(
  sessionId: string,
  facts?: WorkspaceResultPostimage | null,
): Extract<ClaimChange, { kind: "workspace-result" }> {
  return {
    kind: "workspace-result",
    sessionId,
    ...(facts === null
      ? { cleared: true }
      : { facts: captureWorkspaceResultPostimage(sessionId, facts) }),
  };
}
