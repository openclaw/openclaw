import { describe, expect, it, vi } from "vitest";

describe("persistSystemSentAfterSuccess", () => {
  it("does not fail the reply when systemSent persistence throws", async () => {
    vi.resetModules();
    const updateSessionStoreEntryMock = vi.fn(async () => {
      throw new Error("lock timeout");
    });
    const logVerboseMock = vi.fn();

    vi.doMock("../../config/sessions.js", async () => {
      const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
        "../../config/sessions.js",
      );
      return {
        ...actual,
        updateSessionStoreEntry: updateSessionStoreEntryMock,
      };
    });
    vi.doMock("../../globals.js", async () => {
      const actual = await vi.importActual<typeof import("../../globals.js")>("../../globals.js");
      return {
        ...actual,
        logVerbose: logVerboseMock,
      };
    });

    const { persistSystemSentAfterSuccess } = await import("./session-run-accounting.js");
    const sessionEntry = { sessionId: "s1", updatedAt: Date.now(), systemSent: false };

    await expect(
      persistSystemSentAfterSuccess({
        storePath: "/tmp/sessions.json",
        sessionKey: "main",
        sessionEntry,
        runResult: {
          payloads: [],
          meta: { stopReason: "stop" },
        } as never,
      }),
    ).resolves.toBeUndefined();

    expect(updateSessionStoreEntryMock).toHaveBeenCalledTimes(1);
    expect(logVerboseMock).toHaveBeenCalledWith(
      expect.stringContaining("failed to persist systemSent marker"),
    );
    expect(sessionEntry.systemSent).toBe(false);
  });
});
