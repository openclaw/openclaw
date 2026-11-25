type TerminalProducerFence = (
  isCurrent: () => boolean,
  options?: { persistTerminal?: true },
) => Promise<boolean>;

/** Tracks exact persisted-writer fences while their producers can still commit. */
export function createTerminalProducerFenceRegistry(isOwnerSettled: () => boolean) {
  const fences = new Set<TerminalProducerFence>();
  let blocked = false;

  return {
    register(fence: TerminalProducerFence): () => void {
      if (isOwnerSettled()) {
        throw new Error("Operation already settled");
      }
      fences.add(fence);
      return () => fences.delete(fence);
    },
    async revokeAll(
      isCurrent: () => boolean,
      options?: { persistTerminal?: true },
    ): Promise<{ failures: unknown[]; fenced: boolean }> {
      const failures: unknown[] = [];
      const capturedFences = [...fences];
      let fenced = capturedFences.length > 0;
      for (const fence of capturedFences) {
        if (!isCurrent()) {
          return { failures, fenced: false };
        }
        try {
          fenced = (await fence(isCurrent, options)) && fenced;
        } catch (error) {
          fenced = false;
          failures.push(error);
        }
      }
      if (!isCurrent()) {
        return { failures, fenced: false };
      }
      blocked = !fenced;
      return { failures, fenced };
    },
    get blocked(): boolean {
      return blocked;
    },
  };
}
