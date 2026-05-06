import { describe, expect, it, vi } from "vitest";
import { removeSessionManagerTailEntries } from "./session-manager-tail.js";

function createSessionManager() {
  const entries = [
    { type: "session", id: "root", parentId: null },
    { type: "message", id: "a", parentId: "root", message: { role: "user" } },
    { type: "message", id: "b", parentId: "a", message: { role: "assistant" } },
  ];
  return {
    fileEntries: entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
    leafId: "b" as string | null,
    _rewriteFile: vi.fn(),
  };
}

describe("removeSessionManagerTailEntries", () => {
  it("removes matching tail entries and rewrites once", () => {
    const sessionManager = createSessionManager();

    const result = removeSessionManagerTailEntries(
      sessionManager,
      (entry) => entry.type === "message" && entry.id === "b",
    );

    expect(result).toEqual({ removed: 1, unavailable: false, rewriteUnavailable: false });
    expect(sessionManager.fileEntries.map((entry) => entry.id)).toEqual(["root", "a"]);
    expect(sessionManager.byId.has("b")).toBe(false);
    expect(sessionManager.leafId).toBe("a");
    expect(sessionManager._rewriteFile).toHaveBeenCalledTimes(1);
  });

  it("does not mutate when the rewrite hook is unavailable", () => {
    const sessionManager = createSessionManager() as Omit<
      ReturnType<typeof createSessionManager>,
      "_rewriteFile"
    > & { _rewriteFile?: () => void };
    delete sessionManager._rewriteFile;

    const result = removeSessionManagerTailEntries(
      sessionManager,
      (entry) => entry.type === "message" && entry.id === "b",
    );

    expect(result).toEqual({ removed: 0, unavailable: false, rewriteUnavailable: true });
    expect(sessionManager.fileEntries.map((entry) => entry.id)).toEqual(["root", "a", "b"]);
    expect(sessionManager.byId.has("b")).toBe(true);
    expect(sessionManager.leafId).toBe("b");
  });

  it("keeps protected prefix entries", () => {
    const sessionManager = createSessionManager();

    const result = removeSessionManagerTailEntries(sessionManager, () => true, {
      minEntries: 1,
    });

    expect(result.removed).toBe(2);
    expect(sessionManager.fileEntries.map((entry) => entry.id)).toEqual(["root"]);
    expect(sessionManager.leafId).toBe("root");
  });
});
