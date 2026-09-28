import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";

/** Stable active-node identity projected into the dynamic model runtime line. */
type ActiveNodeContext = {
  nodeId: string;
  pairingGeneration?: string;
};

type ActiveNodeContextState = ActiveNodeContext & {
  profileId?: string;
  isCurrent?: () => boolean;
  prepare?: () => Promise<unknown>;
};

let activeNodeContexts = new Map<string | undefined, ActiveNodeContextState>();

function personProfileId(profileId: string | undefined): string | undefined {
  return profileId === GATEWAY_OWNER_PROFILE_ID ? undefined : profileId;
}

export function getActiveNodeIdentityScope(profileId?: string): "requester" | "unknown" {
  return personProfileId(profileId) ? "requester" : "unknown";
}

function snapshotActiveNodeContext(context: ActiveNodeContextState): ActiveNodeContext {
  return {
    nodeId: context.nodeId,
    ...(context.pairingGeneration ? { pairingGeneration: context.pairingGeneration } : {}),
  };
}

/** Replaces the Gateway's prepared choices; no profile can inherit another person's node. */
export function setActiveNodeContexts(next: readonly ActiveNodeContextState[]): void {
  activeNodeContexts = new Map(
    next.map((entry) => [personProfileId(entry.profileId), { ...entry }]),
  );
}

/** Refresh the keyed pairing fact at the existing asynchronous prompt preparation boundary. */
export async function prepareActiveNodeContext(profileId?: string): Promise<void> {
  const key = personProfileId(profileId);
  const captured = activeNodeContexts.get(key);
  try {
    await captured?.prepare?.();
  } catch {
    if (activeNodeContexts.get(key) === captured) {
      activeNodeContexts.delete(key);
    }
  }
}

/** Revalidates the published node before projecting it into an agent prompt. */
export function getCurrentActiveNodeContext(profileId?: string): ActiveNodeContext | null {
  const activeNodeContext = activeNodeContexts.get(personProfileId(profileId));
  if (!activeNodeContext) {
    return null;
  }
  try {
    if (activeNodeContext.isCurrent && !activeNodeContext.isCurrent()) {
      return null;
    }
  } catch {
    return null;
  }
  return snapshotActiveNodeContext(activeNodeContext);
}

/** Bounds the authenticated id; explicit unknown clears stale hints without injecting labels. */
export function formatActiveNodeContextLabel(context: ActiveNodeContext | null): string {
  const nodeId = context?.nodeId;
  return nodeId && /^[a-zA-Z0-9._:-]{1,128}$/.test(nodeId) ? nodeId : "unknown";
}

/** Stable turn context; explicit unknown supersedes a warm runtime's earlier device hint. */
export function buildActiveNodeContextText(profileId?: string): string {
  const nodeId = formatActiveNodeContextLabel(getCurrentActiveNodeContext(profileId));
  const identity = getActiveNodeIdentityScope(profileId);
  return `Current active computer (latest reported app/system input, not message origin): active_node=${nodeId} active_node_identity=${identity}`;
}
