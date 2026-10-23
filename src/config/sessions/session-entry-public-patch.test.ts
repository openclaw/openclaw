import { describe, expect, it } from "vitest";
import { preserveGenerationPrivateFields } from "./session-entry-public-patch.js";
import { mergeSessionEntry, type InternalSessionEntry, type SessionEntry } from "./types.js";

describe("preserveGenerationPrivateFields", () => {
  it("restores titleRefinement across same-session plugin upserts (4304147107)", () => {
    const persistedEntry: InternalSessionEntry = {
      sessionId: "session-1",
      updatedAt: 123,
      lifecycleRevision: "rev-1",
      titleRefinement: {
        sessionId: "session-1",
        generatedName: "Planning",
        taskMessagesSinceTitle: 3,
        refinementDone: false,
        recentMessages: ["task excerpt"],
      },
    };
    // A plugin/SDK upsert projects titleRefinement away before it reaches the
    // store; a same-generation upsert patch must carry the refinement state
    // forward or the bounded refinement loses its count and armed marker.
    const publicPatch: Partial<SessionEntry> = { displayName: "Planning" };
    const patch = preserveGenerationPrivateFields(persistedEntry, publicPatch);
    expect(patch.titleRefinement).toEqual(persistedEntry.titleRefinement);
    expect(patch.displayName).toBe("Planning");
  });

  it.each([{ sessionId: "session-2", lifecycleRevision: "rev-2" }, { lifecycleRevision: "rev-2" }])(
    "clears refinement from the merged replacement lifecycle: %j",
    (rotation) => {
      const persistedEntry: InternalSessionEntry = {
        sessionId: "session-1",
        updatedAt: 123,
        lifecycleRevision: "rev-1",
        titleRefinement: {
          sessionId: "session-1",
          generatedName: "Planning",
          taskMessagesSinceTitle: 1,
          refinementDone: true,
          recentMessages: ["task from retired lifecycle"],
        },
      };
      const patch = preserveGenerationPrivateFields(persistedEntry, rotation);
      const merged: InternalSessionEntry = mergeSessionEntry(persistedEntry, patch);
      expect(merged.lifecycleRevision).toBe("rev-2");
      expect(merged.titleRefinement).toBeUndefined();
    },
  );
});
