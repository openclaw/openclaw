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
  it("returns hot transcript reads without probing restoration", async () => {
    await expect(readRestoredSessionTranscript(scope, () => "hot text")).resolves.toBe("hot text");
    expect(restoreSessionColdTranscript).not.toHaveBeenCalled();
  });

  it("leaves restoration to the host for read-only workers", async () => {
    const cold = new SessionTranscriptColdError(scope.sessionId);
    await expect(
      readRestoredSessionTranscript(
        scope,
        () => {
          throw cold;
        },
        { readOnly: true },
      ),
    ).rejects.toBe(cold);
    expect(restoreSessionColdTranscript).not.toHaveBeenCalled();
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

  it.each([false, true])("restores a cold read once (async=%s)", async (asynchronous) => {
    const cold = new SessionTranscriptColdError(scope.sessionId);
    const read = vi
      .fn<() => string | Promise<string>>()
      .mockImplementationOnce(() => {
        if (asynchronous) {
          return Promise.reject(cold);
        }
        throw cold;
      })
      .mockReturnValue("retained text");

    await expect(readRestoredSessionTranscript(scope, read)).resolves.toBe("retained text");
    expect(read).toHaveBeenCalledTimes(2);
    expect(restoreSessionColdTranscript).toHaveBeenCalledExactlyOnceWith(scope, undefined);
  });

  it.each([new Error("read unavailable"), new SessionTranscriptColdError("another-transcript")])(
    "propagates an unrelated asynchronous read failure: %s",
    async (failure) => {
      const read = vi.fn(async () => {
        throw failure;
      });

      await expect(readRestoredSessionTranscript(scope, read)).rejects.toBe(failure);
      expect(read).toHaveBeenCalledOnce();
      expect(restoreSessionColdTranscript).not.toHaveBeenCalled();
    },
  );

  it("bounds restoration when a peer repeatedly archives the transcript", async () => {
    const cold = new SessionTranscriptColdError(scope.sessionId);
    const read = vi.fn(async () => {
      throw cold;
    });

    await expect(readRestoredSessionTranscript(scope, read)).rejects.toBe(cold);
    expect(read).toHaveBeenCalledTimes(3);
    expect(restoreSessionColdTranscript).toHaveBeenCalledTimes(2);
  });
});
