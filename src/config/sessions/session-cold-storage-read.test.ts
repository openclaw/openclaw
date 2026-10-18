import { beforeEach, describe, expect, it, vi } from "vitest";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { restoreSessionColdTranscript } from "./session-cold-storage.js";

vi.mock("./session-cold-storage.js", () => ({
  restoreSessionColdTranscript: vi.fn(async () => {}),
}));

const scope = { agentId: "main", sessionId: "retained-transcript" };
beforeEach(() => vi.clearAllMocks());

describe("readRestoredSessionTranscript", () => {
  it.each([false, true])("reads a transcript with restoration needed: %s", async (cold) => {
    const coldRead = { target: scope, readMetadata: vi.fn(async () => undefined) };
    const text = cold ? "retained text" : "hot text";
    const read = vi.fn<() => string | Promise<string>>(() => (cold ? Promise.resolve(text) : text));
    if (cold) {
      read.mockRejectedValueOnce(new SessionTranscriptColdError(scope.sessionId));
    }
    await expect(readRestoredSessionTranscript(scope, read, { coldRead })).resolves.toBe(text);
    expect(read).toHaveBeenCalledTimes(cold ? 2 : 1);
    expect(coldRead.readMetadata).not.toHaveBeenCalled();
    if (cold) {
      expect(restoreSessionColdTranscript).toHaveBeenCalledExactlyOnceWith(
        scope,
        undefined,
        coldRead,
      );
    } else {
      expect(restoreSessionColdTranscript).not.toHaveBeenCalled();
    }
  });

  it("rechecks authority after restoration before reading again", async () => {
    const revoked = new Error("reader revoked");
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw revoked;
      }
    };
    vi.mocked(restoreSessionColdTranscript).mockImplementationOnce(async () => {
      current = false;
    });
    const read = vi.fn(() => {
      throw new SessionTranscriptColdError(scope.sessionId);
    });
    await expect(readRestoredSessionTranscript(scope, read, { assertCurrent })).rejects.toBe(
      revoked,
    );
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    [new Error("read unavailable"), false, 1, 0],
    [new SessionTranscriptColdError("another-transcript"), false, 1, 0],
    [new SessionTranscriptColdError(scope.sessionId), true, 1, 0],
    [new SessionTranscriptColdError(scope.sessionId), false, 3, 2],
  ] as const)(
    "propagates %s (readOnly=%s, reads=%i, restorations=%i)",
    async (failure, readOnly, reads, restorations) => {
      const read = vi.fn(() => {
        if (readOnly) {
          throw failure;
        }
        return Promise.reject(failure);
      });
      await expect(
        readRestoredSessionTranscript(scope, read, readOnly ? { readOnly } : undefined),
      ).rejects.toBe(failure);
      expect(read).toHaveBeenCalledTimes(reads);
      expect(restoreSessionColdTranscript).toHaveBeenCalledTimes(restorations);
    },
  );
});
