import { beforeEach, describe, expect, it, vi } from "vitest";

const generateConversationLabelWithFallback = vi.hoisted(() => vi.fn());
const resolveUtilityModelRefForAgent = vi.hoisted(() => vi.fn());
const readSessionTitleFieldsFromTranscript = vi.hoisted(() => vi.fn());
const updateSessionEntry = vi.hoisted(() => vi.fn());
const loadSessionEntry = vi.hoisted(() => vi.fn());

// mock-isolation: Utility model resolution is stubbed to keep the refinement test hermetic.
vi.mock("../agents/utility-model.js", () => ({ resolveUtilityModelRefForAgent }));
// mock-isolation: Label generation is stubbed so refinement tests control naming output directly.
vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback,
}));
// mock-isolation: Title orchestration writes synthetic entry state instead of acquiring a persistence owner.
vi.mock("../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: updateSessionEntry,
}));
// mock-isolation: Title orchestration reads synthetic session entries without starting storage workers.
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: async (scope: unknown) => loadSessionEntry(scope),
}));
// mock-isolation: Registry and transport behavior are covered by the real-provider title suites.
vi.mock("../skills/discovery/chat-commands.js", () => ({
  prepareSkillCommandsForWorkspace: async () => [],
}));
// mock-isolation: Title orchestration tests supply transcript reads without starting workers.
vi.mock("./session-transcript-title-reader.js", () => ({
  readSessionTitleFieldsFromTranscriptAsync: readSessionTitleFieldsFromTranscript,
}));

import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { initializeTitleRefinementState } from "../sessions/session-title-refinement-state.js";
import { maybeRefineDashboardSessionTitle } from "./dashboard-session-title-refinement.js";

const cfg = {
  agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
} as unknown as OpenClawConfig;

const baseEntry: SessionEntry = {
  sessionId: "session-1",
  updatedAt: 1,
} as unknown as SessionEntry;

describe("maybeRefineDashboardSessionTitle", () => {
  const generatedEntry: SessionEntry = {
    ...baseEntry,
    displayName: "First Pass Title",
    titleRefinement: initializeTitleRefinementState("session-1", "First Pass Title"),
  };
  const refineCfg = {
    ...cfg,
    session: { autoTitle: { refine: true, refineAfterMessages: 2 } },
  } as OpenClawConfig;

  function refineParams(entry: SessionEntry | undefined = generatedEntry) {
    loadSessionEntry.mockReturnValue(entry);
    return {
      cfg: refineCfg,
      agentId: "main",
      entry,
      sessionId: "session-1",
      sessionKey: "agent:main:dashboard:chat-1",
      storePath: "/tmp/openclaw/sessions.json",
      userMessage: "Later task message",
    };
  }

  beforeEach(() => {
    generateConversationLabelWithFallback.mockReset();
    updateSessionEntry.mockReset();
    loadSessionEntry.mockReset();
    readSessionTitleFieldsFromTranscript.mockReset();
    readSessionTitleFieldsFromTranscript.mockReturnValue({
      firstUserMessage: "Plan the release",
      lastMessagePreview: "Ship it Friday",
    });
    generateConversationLabelWithFallback.mockResolvedValue("Release Planning");
    resolveUtilityModelRefForAgent.mockReset().mockReturnValue("openai/gpt-5.6-luna");
  });

  it("fail-before: with the old explicit-name guard the threshold write is always rejected; pass-after: counter persists under a generated name", async () => {
    // Threshold below the configured 2 would be rejected by the old
    // !hasExplicitSessionName guard because the entry already carries a
    // generated displayName. The fix persists the counter instead.
    const writes: unknown[] = [];
    updateSessionEntry.mockImplementation(async (_scope, update) => {
      const patch = await update({ ...generatedEntry });
      writes.push(patch);
      const result = patch ? { ...generatedEntry, ...patch } : generatedEntry;
      loadSessionEntry.mockReturnValue(result);
      return result;
    });

    await maybeRefineDashboardSessionTitle(refineParams());

    expect(writes[0]).toEqual({
      titleRefinement: {
        taskMessagesSinceTitle: 1,
        refinementDone: false,
        sessionId: "session-1",
        generatedName: "First Pass Title",
        recentMessages: ["Later task message"],
      },
    });
  });

  it("runs the one-time refinement at threshold and persists the refined name (manual names never overwritten)", async () => {
    let current: SessionEntry = {
      ...generatedEntry,
      titleRefinement: {
        taskMessagesSinceTitle: 1,
        refinementDone: false,
        sessionId: "session-1",
        generatedName: "First Pass Title",
      },
    };
    updateSessionEntry.mockImplementation(async (_scope, update) => {
      const patch = await update({ ...current });
      if (patch) {
        current = { ...current, ...patch };
      }
      loadSessionEntry.mockReturnValue(current);
      return current;
    });

    await maybeRefineDashboardSessionTitle(refineParams(current));

    expect(generateConversationLabelWithFallback).toHaveBeenCalledTimes(1);
    expect(generateConversationLabelWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("concise session title"),
      }),
    );
    expect(current.displayName).toBe("Release Planning");
    expect(current.titleRefinement).toMatchObject({
      refinementDone: true,
      generatedName: "Release Planning",
    });
  });

  it("exactly-once: refinementDone blocks a second refinement even at/after threshold", async () => {
    const doneEntry: SessionEntry = {
      ...generatedEntry,
      titleRefinement: {
        taskMessagesSinceTitle: 9,
        refinementDone: true,
        sessionId: "session-1",
        generatedName: "First Pass Title",
      },
    };
    await maybeRefineDashboardSessionTitle(refineParams(doneEntry));
    expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
    expect(updateSessionEntry).not.toHaveBeenCalled();
  });

  it("manual rename precedence: displayName not matching the owned generated name blocks persistence and generation", async () => {
    let current: SessionEntry = {
      ...generatedEntry,
      displayName: "My Manual Name",
      titleRefinement: {
        taskMessagesSinceTitle: 1,
        refinementDone: false,
        sessionId: "session-1",
        generatedName: "First Pass Title",
      },
    };
    updateSessionEntry.mockImplementation(async (_scope, update) => {
      const patch = await update({ ...current });
      if (patch) {
        current = { ...current, ...patch };
      }
      loadSessionEntry.mockReturnValue(current);
      return current;
    });

    await maybeRefineDashboardSessionTitle(refineParams(current));

    expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
    expect(current.displayName).toBe("My Manual Name");
  });

  it("stale async writer: sessionId change (reset) blocks all refinement writes", async () => {
    const resetEntry: SessionEntry = {
      ...generatedEntry,
      sessionId: "session-2",
      titleRefinement: {
        taskMessagesSinceTitle: 5,
        refinementDone: false,
        sessionId: "session-1",
        generatedName: "First Pass Title",
      },
    };
    await maybeRefineDashboardSessionTitle(refineParams(resetEntry));
    expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
    expect(updateSessionEntry).not.toHaveBeenCalled();
  });

  it("is opt-out by default: refine not configured never generates or writes", async () => {
    updateSessionEntry.mockImplementation(async () => {
      throw new Error("must not write when disabled");
    });
    await maybeRefineDashboardSessionTitle({
      ...refineParams(),
      cfg,
    });
    expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
  });

  it("fail-before: below threshold the first later turn must not claim or infer; pass-after: only the counter persists", async () => {
    // Old defect: the claim patch marked claimed=true at count 1 with
    // afterMessages=2, so the first later message consumed the one-time
    // attempt instead of persisting count 1.
    const writes: unknown[] = [];
    updateSessionEntry.mockImplementation(async (_scope, update) => {
      const patch = await update({ ...generatedEntry });
      writes.push(patch);
      const result = patch ? { ...generatedEntry, ...patch } : generatedEntry;
      loadSessionEntry.mockReturnValue(result);
      return result;
    });
    await maybeRefineDashboardSessionTitle(refineParams());
    expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
    expect(writes[0]).toEqual({
      titleRefinement: {
        taskMessagesSinceTitle: 1,
        refinementDone: false,
        sessionId: "session-1",
        generatedName: "First Pass Title",
        recentMessages: ["Later task message"],
      },
    });
  });

  it("refinement excerpt includes the triggering turn's source when the transcript raced", async () => {
    let current: SessionEntry = {
      ...generatedEntry,
      titleRefinement: {
        taskMessagesSinceTitle: 1,
        refinementDone: false,
        sessionId: "session-1",
        generatedName: "First Pass Title",
      },
    };
    updateSessionEntry.mockImplementation(async (_scope, update) => {
      const patch = await update({ ...current });
      current = patch ? { ...current, ...patch } : current;
      loadSessionEntry.mockReturnValue(current);
      return current;
    });
    await maybeRefineDashboardSessionTitle({
      ...refineParams(current),
      currentUserMessage: "Migrate the billing cron",
    });
    expect(generateConversationLabelWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.stringContaining("Migrate the billing cron"),
      }),
    );
  });

  it("provenance: a displayName without init state is never adopted as generated (4300095321)", async () => {
    // Entry created with an explicit displayName but no titleRefinement
    // provenance: the automatic writer never produced this name, so
    // refinement must not count messages or overwrite it.
    const explicitEntry: SessionEntry = {
      ...baseEntry,
      displayName: "Operator Set Name",
    };
    updateSessionEntry.mockImplementation(async (_scope, update) => {
      const patch = await update({ ...explicitEntry });
      if (patch) {
        Object.assign(explicitEntry, patch);
      }
      return explicitEntry;
    });

    await maybeRefineDashboardSessionTitle(refineParams(explicitEntry));

    expect(updateSessionEntry).not.toHaveBeenCalled();
    expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
    expect(explicitEntry.displayName).toBe("Operator Set Name");
  });

  it("provenance: overlapping turns each increment; no lost counter (4299713772)", async () => {
    // Two background jobs run against the same persisted entry; the second
    // must compute its increment from the first job's persisted state.
    let current: SessionEntry = { ...generatedEntry };
    updateSessionEntry.mockImplementation(async (_scope, update) => {
      const patch = await update({ ...current });
      if (patch) {
        current = { ...current, ...patch };
      }
      loadSessionEntry.mockReturnValue(current);
      return current;
    });

    await Promise.all([
      maybeRefineDashboardSessionTitle(refineParams(current)),
      maybeRefineDashboardSessionTitle(refineParams(current)),
    ]);

    expect(current.titleRefinement?.taskMessagesSinceTitle).toBe(2);
  });

  it("skips the opening turn of a prepared title, then retains middle task context", async () => {
    let current: SessionEntry = {
      ...generatedEntry,
      titleRefinement: initializeTitleRefinementState("session-1", "First Pass Title", {
        skipNextMessage: true,
      }),
    };
    updateSessionEntry.mockImplementation(async (_scope, update) => {
      const patch = await update({ ...current });
      current = patch ? { ...current, ...patch } : current;
      loadSessionEntry.mockReturnValue(current);
      return current;
    });
    readSessionTitleFieldsFromTranscript.mockReturnValue({
      firstUserMessage: "Hello",
      lastMessagePreview: "yes",
    });
    for (const message of ["Open the chat", "Investigate PostgreSQL migration", "yes"]) {
      await maybeRefineDashboardSessionTitle({
        ...refineParams(current),
        currentUserMessage: message,
      });
    }
    expect(current.titleRefinement).toMatchObject({
      taskMessagesSinceTitle: 2,
      refinementDone: true,
    });
    expect(generateConversationLabelWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.stringContaining("Investigate PostgreSQL migration"),
      }),
    );
  });
});
