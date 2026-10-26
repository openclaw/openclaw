import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  mergeSessionEntry,
  resolveSessionResetPolicy,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import {
  appendTranscriptEvent,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import * as transcriptReader from "../../config/sessions/session-transcript-anchor-read.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAgentSessionPatch } from "../server-methods/agent-session-patch.js";
import { prepareAgentSession } from "../server-methods/agent-session-prepare.js";
import * as sessionReader from "../session-utils-store-worker.js";

type PatchParams = Parameters<typeof buildAgentSessionPatch>[0];
const now = 120_001;
const expiredEntry: SessionEntry = {
  sessionId: "original",
  lifecycleRevision: "original-revision",
  updatedAt: 1,
  sessionStartedAt: 1,
  lastInteractionAt: 1,
};
const freshEntry: SessionEntry = { ...expiredEntry, lastInteractionAt: now - 1 };
const failedEntry: SessionEntry = { ...expiredEntry, status: "failed" };
const requested = { requestedSessionId: "requested" };
const resetPolicy = resolveSessionResetPolicy({
  sessionCfg: { reset: { mode: "idle", idleMinutes: 1 } },
  resetType: "direct",
});

function prepare(
  cfg: PatchParams["cfg"],
  sessionKey: string,
  options: Partial<Parameters<typeof prepareAgentSession>[0]> = {},
) {
  return prepareAgentSession({
    cfg,
    requestedSessionKey: sessionKey,
    request: { message: "continue", idempotencyKey: "reuse-proof" },
    canUseCronRunContinuation: false,
    lifecycleGeneration: "reuse-proof",
    respond: () => {
      throw new Error("Unexpected preparation rejection");
    },
    ...options,
  });
}

function buildReusePatch(input: Partial<PatchParams>) {
  return buildAgentSessionPatch({
    freshEntry: expiredEntry,
    initialEntry: expiredEntry,
    cfg: {},
    sessionAgentId: "main",
    canonicalSessionKey: "agent:main:reuse-proof",
    storePath: "/synthetic/session-reuse.sqlite",
    normalizedSpawned: {},
    requestDeliveryHint: undefined,
    hasRestoredCronContinuation: false,
    resetPolicy,
    now,
    isSystemGatewayRun: false,
    visibleRequest: true,
    fallbackSessionId: "replacement",
    touchInteraction: true,
    ...input,
  });
}

it.each(["killed", "failed"] as const)(
  "refreshes %s session reuse after a transcript append without replacing the prepared row",
  async (status) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { session: { reset: { mode: "idle" as const, idleMinutes: 60 } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const timestamp = Date.now();
      const sessionKey = "agent:main:main";
      const sessionId = `original-${status}`;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          status,
          updatedAt: timestamp,
          sessionStartedAt: timestamp,
          lastInteractionAt: timestamp,
        },
      );
      const prepared = await prepare(cfg, sessionKey);
      if (!prepared?.entry) {
        throw new Error("Session preparation did not return the stored row");
      }
      const patchParams = {
        ...prepared,
        freshEntry: prepared.entry,
        initialEntry: prepared.entry,
        canonicalSessionKey: prepared.canonicalKey,
        fallbackSessionId: "after-append",
      };
      const initialPatch = await buildReusePatch(patchParams);
      expect(initialPatch.isNewSession).toBe(status === "failed");
      expect(
        await appendTranscriptEvent(
          { agentId: "main", sessionKey, sessionId, storePath: prepared.storePath },
          { type: "custom", timestamp: new Date(timestamp).toISOString() },
        ),
      ).toBe(true);

      const result = await buildReusePatch(patchParams);
      expect(result.isNewSession).toBe(status === "killed");
      expect(result.patch.sessionId).toBe(status === "killed" ? "after-append" : sessionId);
    });
  },
);

it("backfills the current candidate header while new windows start at the current time", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "current-candidate",
      sessionKey: "agent:main:reuse-header",
      storePath: state.statePath("reuse-header.sqlite"),
    };
    const current: SessionEntry = {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lastInteractionAt: now - 1,
    };
    await upsertSessionEntryCore(scope, current);
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId, version: 3, timestamp: new Date(42).toISOString() },
    ]);
    const candidates: Array<[SessionEntry, SessionEntry, string, number]> = [
      [current, current, scope.sessionId, 42],
      [{ ...current, sessionId: "predecessor" }, current, scope.sessionId, 42],
      [current, { ...current, lastInteractionAt: 1 }, "replacement", now],
    ];
    for (const [initialEntry, candidate, sessionId, sessionStartedAt] of candidates) {
      const result = await buildReusePatch({
        initialEntry,
        freshEntry: candidate,
        canonicalSessionKey: scope.sessionKey,
        storePath: scope.storePath,
      });
      expect(result.patch).toMatchObject({ sessionId, sessionStartedAt });
    }
  });
});

it.each<[Partial<PatchParams>, string, boolean, boolean?]>([
  [{}, "replacement", true],
  [{ freshEntry: undefined, initialEntry: undefined }, "replacement", true],
  [{ freshEntry }, "original", false],
  [{ expectedExistingSessionId: "original" }, "original", false],
  [{ hasRestoredCronContinuation: true }, "original", false],
  [{ freshEntry: failedEntry }, "original", false],
  [{ freshEntry: failedEntry, visibleRequest: false }, "replacement", true],
  [{ freshEntry: { ...freshEntry, status: "failed" } }, "replacement", true, true],
  [{ ...requested, freshEntry: undefined, initialEntry: undefined }, "requested", true],
])(
  "reuses %j as %s (new=%s, transcript missing=%s)",
  async (input, sessionId, isNew, transcriptMissing) => {
    const read = vi.spyOn(transcriptReader, "readSessionTranscriptAnchorsAsync").mockResolvedValue({
      anchors: [],
      metadata: { present: !transcriptMissing, observedAt: null, updatedAt: null },
    });
    try {
      const result = await buildReusePatch(input);
      expect(result).toMatchObject({ patch: { sessionId }, isNewSession: isNew });
      const candidateEntry = "freshEntry" in input ? input.freshEntry : expiredEntry;
      const merged = mergeSessionEntry(candidateEntry, result.patch);
      if (isNew) {
        expect(merged.lifecycleRevision).toEqual(expect.stringMatching(/\S/));
        expect(merged.lifecycleRevision).not.toBe("original-revision");
      } else {
        expect(merged.lifecycleRevision).toBe("original-revision");
      }
    } finally {
      read.mockRestore();
    }
  },
);

it("preserves a legacy session's missing revision when reusing it", async () => {
  const legacyEntry = { ...freshEntry, lifecycleRevision: undefined };
  const { patch } = await buildReusePatch({ freshEntry: legacyEntry });
  expect(mergeSessionEntry(legacyEntry, patch)).toMatchObject({
    sessionId: "original",
    lifecycleRevision: undefined,
  });
});

it("keeps a concurrent replacement after preparing a rotation from the stored row", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { session: { reset: { mode: "idle" as const, idleMinutes: 1 } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:reuse-proof";
    const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
    const scope = { agentId: "main", sessionKey, storePath };
    await upsertSessionEntryCore(scope, expiredEntry);
    const prepared = await prepare(cfg, sessionKey);
    if (!prepared) {
      throw new Error("Session preparation did not return a candidate");
    }
    const initialPatch = await buildReusePatch({
      ...prepared,
      freshEntry: prepared.entry,
      initialEntry: prepared.entry,
      canonicalSessionKey: prepared.canonicalKey,
      fallbackSessionId: undefined,
    });
    expect(initialPatch.isNewSession).toBe(true);
    expect(initialPatch.patch.sessionId).not.toBe("original");
    const concurrent: SessionEntry = {
      ...freshEntry,
      sessionId: "concurrent",
      lifecycleRevision: "concurrent-revision",
      sessionStartedAt: prepared.now,
      lastInteractionAt: prepared.now,
      status: "done",
      lifecycleRunId: "concurrent-run",
      cliSessionIds: { "claude-cli": "native-concurrent" },
    };
    await upsertSessionEntryCore(scope, concurrent);
    const latest = loadSessionEntry(scope);
    const updated = await buildReusePatch({
      ...prepared,
      initialEntry: prepared.entry,
      freshEntry: latest,
      canonicalSessionKey: prepared.canonicalKey,
      requestedSessionId: "original",
      fallbackSessionId: initialPatch.patch.sessionId,
    });
    expect(mergeSessionEntry(latest, updated.patch)).toMatchObject({
      sessionId: "concurrent",
      lifecycleRevision: "concurrent-revision",
      sessionStartedAt: prepared.now,
      status: "done",
      lifecycleRunId: "concurrent-run",
      cliSessionIds: { "claude-cli": "native-concurrent" },
    });
  });
});

it("refuses a replaced expected session after the worker read yields", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {};
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:admission-replacement";
    const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
    const scope = { agentId: "main", sessionKey, storePath };
    await upsertSessionEntryCore(scope, { ...freshEntry, sessionId: "original" });
    const read = sessionReader.loadGatewaySessionEntryReadOnlyInWorker;
    const admission = vi
      .spyOn(sessionReader, "loadGatewaySessionEntryReadOnlyInWorker")
      .mockImplementationOnce(async (...args) => {
        await upsertSessionEntryCore(scope, { ...freshEntry, sessionId: "successor" });
        return read(...args);
      });
    const respond = vi.fn();
    try {
      const prepared = await prepare(cfg, scope.sessionKey, {
        expectedExistingSessionId: "original",
        respond,
      });
      expect(prepared).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining("changed before expected work could start"),
        }),
      );
      expect(loadSessionEntry(scope)?.sessionId).toBe("successor");
    } finally {
      admission.mockRestore();
    }
  });
});
