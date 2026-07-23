// Real behavior proof for PR #102128:
// shows requireWriteSuccess:true propagates a store write failure as a thrown
// error for the pendingFinalDelivery write path.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { saveSessionStore } from "../../config/sessions/store.js";
import * as jsonFiles from "../../infra/json-files.js";
import * as replaceFileModule from "../../infra/replace-file.js";

describe("pendingFinalDelivery requireWriteSuccess", () => {
  const tempDirTracker = useAutoCleanupTempDirTracker(afterEach);
  let storePath: string;
  const sessionKey = "main";

  beforeEach(() => {
    storePath = path.join(tempDirTracker.make("pfd-proof-"), "sessions.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("propagates store write failure WITH requireWriteSuccess:true (PR #102128)", async () => {
    // Arrange: fresh session entry in the store
    await saveSessionStore(
      storePath,
      { [sessionKey]: { sessionId: "session", updatedAt: Date.now() } },
      { skipMaintenance: true },
    );

    // Inject a store write failure — ENOENT is the code the store checks
    const writeError = Object.assign(new Error("write failed: ENOENT"), { code: "ENOENT" });
    vi.spyOn(jsonFiles, "writeTextAtomic").mockRejectedValue(writeError);

    // Act + Assert: with requireWriteSuccess:true, the error propagates
    await expect(
      updateSessionEntry(
        { storePath, sessionKey },
        () => ({
          pendingFinalDelivery: true,
          pendingFinalDeliveryText: "hello from proof test",
          pendingFinalDeliveryContext: {},
          pendingFinalDeliveryCreatedAt: Date.now(),
          updatedAt: Date.now(),
        }),
        {
          skipMaintenance: true,
          takeCacheOwnership: true,
          requireWriteSuccess: true, // <-- THE PR CHANGE
        },
      ),
    ).rejects.toThrow("write failed: ENOENT");
  });

  // ---------------------------------------------------------------------------
  // Contrast proofs: full write path (non-singleEntryPersistence) via
  // saveSessionStore, where requireWriteSuccess controls ENOENT behavior.
  // saveSessionStore does NOT set singleEntryPersistence (it writes the full
  // store), so the code falls through to the retry/ENOENT handling at
  // store.ts:967-1007.
  //
  // Mock layer: replaceFileAtomic (one level below writeTextAtomic) from
  // src/infra/replace-file.ts, which is the boundary between json-files.ts
  // and the @openclaw/fs-safe package.
  // ---------------------------------------------------------------------------

  it("full path: ENOENT propagates WITH requireWriteSuccess:true", async () => {
    // Arrange: establish a store on disk so the cache has serialized content
    await saveSessionStore(
      storePath,
      { [sessionKey]: { sessionId: "s1", updatedAt: Date.now() } },
      { skipMaintenance: true },
    );

    // Mock replaceFileAtomic (one level below writeTextAtomic, at the
    // @openclaw/fs-safe boundary) to throw ENOENT.
    const writeError = Object.assign(new Error("ENOENT from replaceFileAtomic"), { code: "ENOENT" });
    const spy = vi.spyOn(replaceFileModule, "replaceFileAtomic").mockRejectedValue(writeError);

    // Act + Assert: requireWriteSuccess:true → the store's ENOENT handler
    // (store.ts:994-997) re-throws the error after the retry-exhausted path.
    await expect(
      saveSessionStore(
        storePath,
        { [sessionKey]: { sessionId: "s2", updatedAt: Date.now() + 1 } },
        { skipMaintenance: true, requireWriteSuccess: true },
      ),
    ).rejects.toThrow("ENOENT from replaceFileAtomic");

    expect(spy).toHaveBeenCalledTimes(2); // initial attempt + 1 retry
  });

  it("full path: ENOENT silently swallowed WITHOUT requireWriteSuccess (current main)", async () => {
    // Arrange: establish a store on disk so the cache has serialized content
    await saveSessionStore(
      storePath,
      { [sessionKey]: { sessionId: "s1", updatedAt: Date.now() } },
      { skipMaintenance: true },
    );

    // Same ENOENT mock at the replaceFileAtomic level
    const writeError = Object.assign(new Error("ENOENT from replaceFileAtomic"), { code: "ENOENT" });
    const spy = vi.spyOn(replaceFileModule, "replaceFileAtomic").mockRejectedValue(writeError);

    // Act + Assert: WITHOUT requireWriteSuccess (matches current main), the
    // store silently recovers. The call resolves successfully even though the
    // write failed — this is the data-loss scenario the PR fixes.
    await expect(
      saveSessionStore(
        storePath,
        { [sessionKey]: { sessionId: "s2", updatedAt: Date.now() + 1 } },
        { skipMaintenance: true }, // requireWriteSuccess NOT set
      ),
    ).resolves.toBeUndefined();

    // The mock was called (write attempted twice) but the error was swallowed
    expect(spy).toHaveBeenCalledTimes(2); // initial attempt + 1 retry
  });
});
