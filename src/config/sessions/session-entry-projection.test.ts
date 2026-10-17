import { describe, expect, it } from "vitest";
import {
  projectPluginSessionEntry,
  projectPluginSessionEntryPatch,
} from "../../plugin-sdk/session-store-runtime-internal.js";
import {
  projectPublicSessionEntry,
  projectPublicSessionEntryPatch,
} from "./session-entry-projection.js";
import type { InternalSessionEntry } from "./types.js";

describe("public session entry projection", () => {
  it("keeps title refinement task excerpts out of public and plugin entries and patches", () => {
    const titleRefinement = {
      sessionId: "session-1",
      generatedName: "Planning",
      taskMessagesSinceTitle: 8,
      refinementDone: false,
      recentMessages: Array.from({ length: 8 }, (_, index) => `Private task excerpt ${index}`),
    };
    const entry: InternalSessionEntry = {
      sessionId: "session-1",
      updatedAt: 123,
      displayName: "Planning",
      titleRefinement,
    };
    const expected = { sessionId: "session-1", updatedAt: 123, displayName: "Planning" };

    for (const projected of [
      projectPublicSessionEntry(entry),
      projectPublicSessionEntryPatch(entry),
      projectPluginSessionEntry(entry),
      projectPluginSessionEntryPatch(entry),
    ]) {
      expect(projected).toEqual(expected);
      expect(JSON.stringify(projected)).not.toContain("Private task excerpt");
    }
    expect(entry.titleRefinement).toBe(titleRefinement);
  });
});
