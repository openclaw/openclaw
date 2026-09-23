import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry } from "../config/sessions.js";
import type { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { setSessionActivitySummaryState } from "./session-activity-summary-state.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { defaultPersistDigest } from "./session-observer-model.js";

const persistence = vi.hoisted(() => ({ patch: vi.fn(), load: vi.fn() }));
vi.mock("../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: persistence.patch,
  loadSessionEntryReadOnly: vi.fn(),
  readSessionTranscriptWatermark: vi.fn(),
  appendSessionTranscriptReport: vi.fn(async () => ({ ok: true, value: undefined })),
}));
vi.mock("./session-utils.js", () => ({ loadSessionEntry: persistence.load }));

const target = {
  sessionKey: "agent:main:owner-publications",
  agentId: "main",
  storePath: "/tmp/owner-publications/sessions.json",
};
let entry: InternalSessionEntry;
let rejectCommit: boolean;
beforeEach(() => {
  entry = { sessionId: "owner-publications", updatedAt: 1_000 };
  rejectCommit = false;
  persistence.load.mockReset().mockImplementation(() => ({
    ...target,
    canonicalKey: target.sessionKey,
    entry,
  }));
  persistence.patch
    .mockReset()
    .mockImplementation(async (...args: Parameters<typeof patchSessionEntryCore>) => {
      const [, update, options] = args;
      const patch = await update({ ...entry }, { existingEntry: { ...entry } });
      if (patch) {
        if (rejectCommit) {
          throw new Error("commit rejected");
        }
        entry = { ...entry, ...patch };
        options?.onCommitted?.({ ...entry });
      }
      return { ...entry };
    });
});

describe("gateway session row change publications", () => {
  it.each(["start", "end", "error"] as const)(
    "publishes lifecycle %s only after an accepted commit",
    async (phase) => {
      const changed = vi.fn();
      const unsubscribe = sessionChanges.subscribe(changed);
      const write = (sessionId = entry.sessionId) =>
        persistGatewaySessionLifecycleEvent({
          sessionKey: target.sessionKey,
          agentId: target.agentId,
          event: { sessionId, runId: "row-run", ts: 2_000, data: { phase } },
        });
      try {
        rejectCommit = true;
        await expect(write()).rejects.toThrow("commit rejected");
        expect(changed).not.toHaveBeenCalled();
        rejectCommit = false;
        await write();
        expect(changed).toHaveBeenCalledExactlyOnceWith(target);
        await write("replaced-generation");
        expect(changed).toHaveBeenCalledTimes(1);
      } finally {
        unsubscribe();
      }
    },
  );

  it("publishes observer digests only after an accepted commit", async () => {
    const changed = vi.fn();
    const unsubscribe = sessionChanges.subscribe(changed);
    const write = () =>
      defaultPersistDigest({
        ...target,
        sessionId: entry.sessionId,
        digest: {
          sessionKey: target.sessionKey,
          runId: "row-run",
          revision: 1,
          updatedAt: 2_000,
          headline: "Checking files",
          health: "on-track",
        },
      });
    try {
      rejectCommit = true;
      await expect(write()).rejects.toThrow("commit rejected");
      expect(changed).not.toHaveBeenCalled();
      rejectCommit = false;
      expect(await write()).toBe(true);
      expect(changed).toHaveBeenCalledExactlyOnceWith(target);
      expect(await write()).toBe(false);
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("publishes activity admission, updates, and owner-held drops", () => {
    const changed = vi.fn();
    const unsubscribe = sessionChanges.subscribe(changed);
    const owner = Symbol("activity-owner");
    const successor = Symbol("next-activity-owner");
    const activityTarget = { key: target.sessionKey, agentId: target.agentId };
    const value = {
      sessionId: entry.sessionId,
      storePath: target.storePath,
      state: "stale" as const,
    };
    try {
      expect(setSessionActivitySummaryState(activityTarget, owner, value)).toBe(true);
      expect(setSessionActivitySummaryState(activityTarget, owner, value)).toBe(false);
      expect(
        setSessionActivitySummaryState(activityTarget, owner, { ...value, state: "updating" }),
      ).toBe(true);
      expect(
        setSessionActivitySummaryState(
          activityTarget,
          owner,
          { ...value, state: "updating" },
          true,
        ),
      ).toBe(true);
      expect(setSessionActivitySummaryState(activityTarget, successor, value)).toBe(true);
      expect(setSessionActivitySummaryState(activityTarget, owner)).toBe(false);
      expect(setSessionActivitySummaryState(activityTarget, successor)).toBe(true);
      expect(changed.mock.calls).toEqual(
        Array.from({ length: 5 }, () => [
          {
            sessionKey: target.sessionKey,
            agentId: target.agentId,
          },
        ]),
      );
    } finally {
      unsubscribe();
      setSessionActivitySummaryState(activityTarget, owner);
      setSessionActivitySummaryState(activityTarget, successor);
    }
  });
});
