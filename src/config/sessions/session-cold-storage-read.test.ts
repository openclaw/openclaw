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
    expect(restoreSessionColdTranscript).toHaveBeenCalledTimes(2);
    expect(restoreSessionColdTranscript).toHaveBeenNthCalledWith(1, scope, undefined);
    expect(restoreSessionColdTranscript).toHaveBeenNthCalledWith(2, scope, undefined);
  });

  it.each([new Error("read unavailable"), new SessionTranscriptColdError("another-transcript")])(
    "propagates an unrelated asynchronous read failure: %s",
    async (failure) => {
      const read = vi.fn(async () => {
        throw failure;
      });

      await expect(readRestoredSessionTranscript(scope, read)).rejects.toBe(failure);
      expect(read).toHaveBeenCalledOnce();
      expect(restoreSessionColdTranscript).toHaveBeenCalledExactlyOnceWith(scope, undefined);
    },
  );

  it("propagates a second cold rejection without repeating restoration", async () => {
    const cold = new SessionTranscriptColdError(scope.sessionId);
    const read = vi.fn(async () => {
      throw cold;
    });

    await expect(readRestoredSessionTranscript(scope, read)).rejects.toBe(cold);
    expect(read).toHaveBeenCalledTimes(2);
    expect(restoreSessionColdTranscript).toHaveBeenCalledTimes(2);
  });
});
