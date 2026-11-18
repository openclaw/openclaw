type DirectPendingFinalIdentity = { sessionId: string; intentId: string };

// Process-local custody defers a matching uncertainty notice until its live send settles.
const activeDeliveries = new Set<DirectPendingFinalIdentity>();

export function trackActiveDirectPendingFinalDelivery(
  completion: DirectPendingFinalIdentity,
): () => void {
  activeDeliveries.add(completion);
  return () => {
    activeDeliveries.delete(completion);
  };
}

export function hasActiveDirectPendingFinalDelivery(sessionId: string, intentId: string): boolean {
  for (const completion of activeDeliveries) {
    if (completion.sessionId === sessionId && completion.intentId === intentId) {
      return true;
    }
  }
  return false;
}
