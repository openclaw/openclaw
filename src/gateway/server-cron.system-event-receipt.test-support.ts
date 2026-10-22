export function createCronSystemEventMocks(
  enqueue: (text: string, opts?: unknown) => unknown,
  remove: () => boolean,
) {
  return {
    enqueueSystemEvent: enqueue,
    enqueueSystemEventWithReceipt(
      text: string,
      opts?: unknown,
      receipt?: { onSettled?: (adopted: boolean) => void },
    ) {
      const result = enqueue(text, opts);
      if (result === false || result === null) {
        return null;
      }
      // Wiring fixtures complete accepted events immediately; queue custody has real-owner proof.
      receipt?.onSettled?.(true);
      return remove;
    },
  };
}
