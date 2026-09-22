/** Stable active-node identity projected into the dynamic model runtime line. */
type ActiveNodeContext = {
  nodeId: string;
  pairingGeneration?: string;
};

type ActiveNodeContextState = ActiveNodeContext & {
  isCurrent?: () => boolean;
  prepare?: () => Promise<unknown>;
};

let activeNodeContext: ActiveNodeContextState | null = null;

function snapshotActiveNodeContext(context: ActiveNodeContextState): ActiveNodeContext {
  return {
    nodeId: context.nodeId,
    ...(context.pairingGeneration ? { pairingGeneration: context.pairingGeneration } : {}),
  };
}

/** Publishes the gateway's current active-node choice without volatile timestamps. */
export function setActiveNodeContext(
  next: ActiveNodeContext | null,
  options?: { isCurrent?: () => boolean; prepare?: () => Promise<unknown> },
): void {
  activeNodeContext = next ? { ...next, ...options } : null;
}

/** Refresh the keyed pairing fact at the existing asynchronous prompt preparation boundary. */
export async function prepareActiveNodeContext(): Promise<void> {
  const captured = activeNodeContext;
  try {
    await captured?.prepare?.();
  } catch {
    if (activeNodeContext === captured) {
      activeNodeContext = null;
    }
  }
}

/** Revalidates the published node before projecting it into an agent prompt. */
export function getCurrentActiveNodeContext(): ActiveNodeContext | null {
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
export function buildActiveNodeContextText(): string {
  const nodeId = formatActiveNodeContextLabel(getCurrentActiveNodeContext());
  return `Current active computer (latest physical input, not message origin): active_node=${nodeId}`;
}
