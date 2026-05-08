import { describe, expect, it, vi } from "vitest";
import { removeSessionManagerTailEntries } from "./session-manager-tail.js";

function createSessionManager() {
  const entries = [
    { type: "session", id: "root", parentId: null },
    { type: "message", id: "a", parentId: "root", message: { role: "user" } },
    { type: "message", id: "b", parentId: "a", message: { role: "assistant" } },
  ];
  const sessionManager = {
    entries,
    leafId: "b" as string | null,
    removeTailEntries: vi.fn(
      (
        shouldRemove: (entry: (typeof entries)[number]) => boolean,
        options?: { maxEntries?: number; minEntries?: number },
      ) => {
        const minEntries = options?.minEntries ?? 0;
        const maxEntries = options?.maxEntries ?? Number.POSITIVE_INFINITY;
        let removed = 0;
        while (entries.length > minEntries && removed < maxEntries) {
          const last = entries.at(-1);
          if (!last || !shouldRemove(last)) {
            break;
          }
          entries.pop();
          removed += 1;
        }
        if (removed > 0) {
          sessionManager.leafId = entries.at(-1)?.id ?? null;
        }
        return removed;
      },
    ),
  };
  return sessionManager;
}

describe("removeSessionManagerTailEntries", () => {
  it("removes matching tail entries through the public session-manager API", () => {
    const sessionManager = createSessionManager();

    const result = removeSessionManagerTailEntries(
      sessionManager,
      (entry) => entry.type === "message" && entry.id === "b",
    );

    expect(result).toEqual({ removed: 1, unavailable: false, rewriteUnavailable: false });
    expect(sessionManager.entries.map((entry) => entry.id)).toEqual(["root", "a"]);
    expect(sessionManager.leafId).toBe("a");
    expect(sessionManager.removeTailEntries).toHaveBeenCalledTimes(1);
  });

  it("does not mutate when the public tail removal API is unavailable", () => {
    const sessionManager = createSessionManager() as unknown as Omit<
      ReturnType<typeof createSessionManager>,
      "removeTailEntries"
    > & { removeTailEntries?: undefined };
    delete sessionManager.removeTailEntries;

    const result = removeSessionManagerTailEntries(
      sessionManager,
      (entry) => entry.type === "message" && entry.id === "b",
    );

    expect(result).toEqual({ removed: 0, unavailable: true, rewriteUnavailable: false });
    expect(sessionManager.entries.map((entry) => entry.id)).toEqual(["root", "a", "b"]);
    expect(sessionManager.leafId).toBe("b");
  });

  it("keeps protected prefix entries", () => {
    const sessionManager = createSessionManager();

    const result = removeSessionManagerTailEntries(sessionManager, () => true, {
      minEntries: 1,
    });

    expect(result.removed).toBe(2);
    expect(sessionManager.entries.map((entry) => entry.id)).toEqual(["root"]);
    expect(sessionManager.leafId).toBe("root");
  });
});
