/**
 * Regression test for #14717: path.dirname(undefined) crash in withSessionStoreLock
 *
 * When a channel plugin passes undefined as storePath to recordSessionMetaFromInbound,
 * the call chain reaches withSessionStoreLock → path.dirname(undefined) → TypeError crash.
 * After fix, a clear Error is thrown instead of an unhandled TypeError.
 */
import { describe, expect, it } from "vitest";
import { updateSessionStore } from "./store.js";

describe("withSessionStoreLock storePath guard (#14717)", () => {
  it("throws descriptive error when storePath is undefined", async () => {
    await expect(
      updateSessionStore(undefined as unknown as string, (store) => store),
    ).rejects.toThrow("withSessionStoreLock: storePath must be a non-empty string");
  });

  it("throws descriptive error when storePath is empty string", async () => {
    await expect(updateSessionStore("", (store) => store)).rejects.toThrow(
      "withSessionStoreLock: storePath must be a non-empty string",
    );
  });
});
