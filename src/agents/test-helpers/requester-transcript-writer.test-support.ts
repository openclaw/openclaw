import { vi } from "vitest";

export function createRequesterTranscriptWriter(isDisposed: () => boolean) {
  const requesterTranscriptWrite = vi.fn();
  const withRequesterTranscriptWrite = async <T>(operation: () => Promise<T> | T): Promise<T> => {
    requesterTranscriptWrite();
    if (isDisposed()) {
      throw new Error("attempt disposed before transcript write");
    }
    return await operation();
  };
  return { requesterTranscriptWrite, withRequesterTranscriptWrite };
}
