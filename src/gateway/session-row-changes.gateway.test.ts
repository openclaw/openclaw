import { beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import type { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { setSessionActivitySummaryState } from "./session-activity-summary-state.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { defaultPersistDigest } from "./session-observer-model.js";
import type { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

const persistence = vi.hoisted(() => ({
  patch: vi.fn(),
  load: vi.fn<typeof loadGatewaySessionEntryReadOnlyInWorker>(),
}));
vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-accessor.js")>()),
  patchSessionEntryCore: persistence.patch,
  patchSessionEntryTarget: persistence.patch,
  loadSessionEntryReadOnly: vi.fn(),
  readSessionTranscriptWatermark: vi.fn(),
  appendSessionTranscriptReport: vi.fn(async () => ({ ok: true, value: undefined })),
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
  it.each(["lifecycle errors", "observer digests"] as const)(
    "publishes %s only after an accepted commit",
    async (source) => {
      const { changed, facts, unsubscribe } = observeChanges();
      const write = (sessionId = entry.sessionId) =>
        source === "lifecycle errors"
          ? persistGatewaySessionLifecycleEvent({
              sessionKey: target.sessionKey,
              agentId: target.agentId,
              event: { sessionId, runId: "row-run", ts: 2_000, data: { phase: "error" } },
            })
          : defaultPersistDigest({
              ...target,
              sessionId,
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
        expect(facts).not.toHaveBeenCalled();
        rejectCommit = false;
        const committed = await write();
        if (source === "observer digests") {
          expect(committed).toBe(true);
        }
        expect(changed).toHaveBeenCalledExactlyOnceWith({ ...target, scope: "runtime" });
        expect(facts).toHaveBeenCalledExactlyOnceWith({
          ...target,
          scope: "runtime",
          facts: { kind: "unchanged" },
        });
        if (source === "lifecycle errors") {
          await write("replaced-generation");
        } else {
          expect(await write()).toBe(false);
        }
        expect(changed).toHaveBeenCalledTimes(1);
        expect(facts).toHaveBeenCalledTimes(1);
      } finally {
        unsubscribe();
      }
    },
  );

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
