export type NodeWorkspaceTransferOwner = {
  credential: { ownerEpoch: number; sessionId: string | null } | undefined;
  environment: {
    ownerEpoch: number;
    attachedSessionIds: string[];
    destroyRequestedAtMs: number | null;
    state: string;
  };
};

export function isNodeWorkspaceTransferOwnerCurrent(
  binding: { ownerEpoch: number; sessionId: string },
  owner: NodeWorkspaceTransferOwner | undefined,
): boolean {
  const environment = owner?.environment;
  const credential = owner?.credential;
  // Credential deletion fences teardown before asynchronous tunnel stop; its RPC
  // admission expiry does not end workspace custody. Transfers have their own TTL.
  return Boolean(
    environment &&
    credential &&
    environment.state === "attached" &&
    environment.destroyRequestedAtMs === null &&
    environment.ownerEpoch === binding.ownerEpoch &&
    environment.attachedSessionIds.length === 1 &&
    environment.attachedSessionIds[0] === binding.sessionId &&
    credential.ownerEpoch === binding.ownerEpoch &&
    credential.sessionId === binding.sessionId,
  );
}
