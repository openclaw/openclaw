/**
 * Contiguous update offset watermark tracker.
 *
 * Tracks in-flight and completed Telegram update IDs, and only advances
 * the persisted offset to the highest contiguous completed update_id.
 * This prevents out-of-order completion from skipping lower-numbered updates
 * that are still being processed (TCP ACK window approach).
 */
export interface UpdateOffsetWatermark {
  markStarted(updateId: number): void;
  markCompleted(updateId: number): void;
  getCurrentOffset(): number | null;
}

export function createUpdateOffsetWatermark(
  initialOffset: number | null,
  onPersist: (offset: number) => void,
): UpdateOffsetWatermark {
  let currentOffset = initialOffset;
  const inFlight = new Set<number>();
  const completed = new Set<number>();

  function tryAdvance() {
    if (completed.size === 0) return;

    let watermark = currentOffset;

    if (inFlight.size === 0) {
      // No in-flight updates — safe to advance to max completed
      const maxCompleted = Math.max(...completed);
      watermark = watermark !== null ? Math.max(watermark, maxCompleted) : maxCompleted;
      completed.clear();
    } else {
      // Advance only up to (minInFlight - 1) using completed IDs
      const minInFlight = Math.min(...inFlight);
      // Can safely acknowledge everything below the lowest in-flight
      for (const id of [...completed].sort((a, b) => a - b)) {
        if (id < minInFlight) {
          watermark = watermark !== null ? Math.max(watermark, id) : id;
          completed.delete(id);
        }
      }
    }

    if (watermark !== null && (currentOffset === null || watermark > currentOffset)) {
      currentOffset = watermark;
      onPersist(watermark);
    }
  }

  return {
    markStarted(updateId: number) {
      inFlight.add(updateId);
    },
    markCompleted(updateId: number) {
      inFlight.delete(updateId);
      completed.add(updateId);
      tryAdvance();
    },
    getCurrentOffset() {
      return currentOffset;
    },
  };
}
