import { beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import type { applySessionEntryTargetOperation } from "../config/sessions/session-accessor.sqlite-entry.js";
import { projectSessionEntryPatch } from "../config/sessions/session-entry-patch-operation.js";
import type { SessionLifecyclePatchEffects } from "../config/sessions/session-run-lifecycle-projection.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { setSessionActivitySummaryState } from "./session-activity-summary-state.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import type { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

const persistence = vi.hoisted(() => ({
  patch: vi.fn(),
  load: vi.fn<typeof loadGatewaySessionEntryReadOnlyInWorker>(),
}));
vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-accessor.js")>()),
  loadSessionEntryReadOnly: vi.fn(),
  readSessionTranscriptWatermark: vi.fn(),
  appendSessionTranscriptReport: vi.fn(async () => ({ ok: true, value: undefined })),
}));
vi.mock("../config/sessions/session-accessor.sqlite-entry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-accessor.sqlite-entry.js")>()),
  applySessionEntryTargetOperation: persistence.patch,
}));
vi.mock("./session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: persistence.load,
}));

const target = {
  sessionKey: "agent:main:owner-publications",
  agentId: "main",
  storePath: "/tmp/owner-publications/sessions.json",
};
let entry: InternalSessionEntry;
let rejectCommit: boolean;
beforeEach(() => {
  setRuntimeConfigSnapshot({}, {});
  entry = { sessionId: "owner-publications", updatedAt: 1_000 };
  rejectCommit = false;
  persistence.load.mockReset().mockImplementation(async ({ cfg }) => ({
    cfg,
    ...target,
    canonicalKey: target.sessionKey,
    storeKeys: [target.sessionKey],
    store: { [target.sessionKey]: entry },
    entry,
    legacyKey: undefined,
  }));
  persistence.patch
    .mockReset()
    .mockImplementation(async (...args: Parameters<typeof applySessionEntryTargetOperation>) => {
      const [, operation, options] = args;
      let effects: SessionLifecyclePatchEffects | undefined;
      const next = projectSessionEntryPatch({
        existing: entry,
        writeBase: entry,
        sessionKey: target.sessionKey,
        operation,
        onLifecycleProjection: (value) => {
          effects = value;
        },
      });
      if (next) {
        if (rejectCommit) {
          throw new Error("commit rejected");
        }
        entry = next;
        options?.onCommitted?.({ ...entry }, undefined, effects);
      }
      return { ...entry };
    });
});

function observeChanges() {
  const changed = vi.fn();
  const facts = vi.fn();
  const stop = sessionChanges.subscribe(changed);
  const stopFacts = sessionChanges.subscribeFacts(facts);
  return {
    changed,
    facts,
    unsubscribe: () => {
      stop();
      stopFacts();
    },
  };
}

describe("gateway session row change publications", () => {
  it("publishes lifecycle errors only after an accepted commit", async () => {
    const { changed, facts, unsubscribe } = observeChanges();
    const write = (sessionId = entry.sessionId) =>
      persistGatewaySessionLifecycleEvent({
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        event: { sessionId, runId: "row-run", ts: 2_000, data: { phase: "error" } },
      });
    try {
      rejectCommit = true;
      await expect(write()).rejects.toThrow("commit rejected");
      expect(changed).not.toHaveBeenCalled();
      expect(facts).not.toHaveBeenCalled();
      rejectCommit = false;
      await write();
      expect(changed).toHaveBeenCalledExactlyOnceWith({ ...target, scope: "runtime" });
      expect(facts).toHaveBeenCalledExactlyOnceWith({
        ...target,
        scope: "runtime",
        facts: { kind: "unchanged" },
      });
      await write("replaced-generation");
      expect(changed).toHaveBeenCalledTimes(1);
      expect(facts).toHaveBeenCalledTimes(1);
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
            scope: "runtime",
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
