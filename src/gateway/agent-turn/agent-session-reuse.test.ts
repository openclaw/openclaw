import { describe, expect, it, vi } from "vitest";
import {
  mergeSessionEntry,
  resolveSessionResetPolicy,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import {
  loadSessionEntry,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAgentSessionPatch } from "../server-methods/agent-session-patch.js";
import { prepareAgentSession } from "../server-methods/agent-session-prepare.js";

type PatchParams = Parameters<typeof buildAgentSessionPatch>[0];
const now = 120_001;
const expiredEntry: SessionEntry = {
  sessionId: "original",
  updatedAt: 1,
  sessionStartedAt: 1,
  lastInteractionAt: 1,
};
const freshEntry: SessionEntry = { ...expiredEntry, lastInteractionAt: now - 1 };
const resetPolicy = resolveSessionResetPolicy({
  sessionCfg: { reset: { mode: "idle", idleMinutes: 1 } },
  resetType: "direct",
});

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
    failedSessionTranscriptMissing: () => false,
    ...input,
  });
}

describe("agent session reuse at mutation", () => {
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
      for (const candidate of [
        { initial: current, fresh: current, expectedId: scope.sessionId, startedAt: 42 },
        {
          initial: { ...current, sessionId: "predecessor" },
          fresh: current,
          expectedId: scope.sessionId,
          startedAt: 42,
        },
        {
          initial: current,
          fresh: { ...current, lastInteractionAt: 1 },
          expectedId: "replacement",
          startedAt: now,
        },
      ]) {
        const result = await buildReusePatch({
          initialEntry: candidate.initial,
          freshEntry: candidate.fresh,
          canonicalSessionKey: scope.sessionKey,
          storePath: scope.storePath,
        });
        expect(result.patch).toMatchObject({
          sessionId: candidate.expectedId,
          sessionStartedAt: candidate.startedAt,
        });
      }
    });
  });

  it.each([
    { name: "expired ordinary turn", input: {}, sessionId: "replacement", isNew: true },
    { name: "fresh ordinary turn", input: { freshEntry }, sessionId: "original", isNew: false },
    {
      name: "expected existing identity",
      input: { expectedExistingSessionId: "original" },
      sessionId: "original",
      isNew: false,
    },
    {
      name: "restored cron continuation",
      input: { hasRestoredCronContinuation: true },
      sessionId: "original",
      isNew: false,
    },
    {
      name: "model-locked identity",
      input: { freshEntry: { ...expiredEntry, modelSelectionLocked: true } },
      sessionId: "original",
      isNew: false,
    },
    {
      name: "visible terminal recovery",
      input: { freshEntry: { ...expiredEntry, status: "failed" } },
      sessionId: "original",
      isNew: false,
    },
    {
      name: "background terminal expiry",
      input: { freshEntry: { ...expiredEntry, status: "failed" }, visibleRequest: false },
      sessionId: "replacement",
      isNew: true,
    },
    {
      name: "missing failed transcript",
      input: {
        freshEntry: { ...freshEntry, status: "failed" },
        failedSessionTranscriptMissing: () => true,
      },
      sessionId: "replacement",
      isNew: true,
    },
    {
      name: "requested identity for an expired row",
      input: { requestedSessionId: "requested" },
      sessionId: "replacement",
      isNew: true,
    },
    {
      name: "requested identity for a fresh row",
      input: { freshEntry, requestedSessionId: "requested" },
      sessionId: "requested",
      isNew: true,
    },
    {
      name: "requested identity for a missing row",
      input: { freshEntry: undefined, initialEntry: undefined, requestedSessionId: "requested" },
      sessionId: "requested",
      isNew: true,
    },
  ] satisfies Array<{
    name: string;
    input: Partial<PatchParams>;
    sessionId: string;
    isNew: boolean;
  }>)("preserves $name", async ({ input, sessionId, isNew }) => {
    const result = await buildReusePatch(input);
    expect(result.patch.sessionId).toBe(sessionId);
    expect(result.isNewSession).toBe(isNew);
  });

  it("keeps a concurrent replacement after preparing a rotation from the stored row", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { session: { reset: { mode: "idle" as const, idleMinutes: 1 } } };
      await state.writeConfig(cfg);
      const sessionKey = "agent:main:reuse-proof";
      const scope = {
        agentId: "main",
        sessionKey,
        storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
      };
      await upsertSessionEntryCore(scope, expiredEntry);
      const prepared = await prepareAgentSession({
        cfg,
        requestedSessionKey: sessionKey,
        request: { message: "continue", idempotencyKey: "reuse-proof" },
        canUseCronRunContinuation: false,
        lifecycleGeneration: "reuse-proof",
        respond: () => {
          throw new Error("Unexpected preparation rejection");
        },
      });
      if (!prepared) {
        throw new Error("Session preparation did not return a candidate");
      }
      expect(prepared.isNewSession).toBe(true);
      expect(prepared.sessionId).not.toBe("original");
      const concurrent: SessionEntry = {
        ...freshEntry,
        sessionId: "concurrent",
        sessionStartedAt: prepared.now,
        lastInteractionAt: prepared.now,
        status: "done",
        lifecycleRunId: "concurrent-run",
        cliSessionIds: { "claude-cli": "native-concurrent" },
      };
      await upsertSessionEntryCore(scope, concurrent);
      const latest = loadSessionEntry(scope);
      const updated = await buildReusePatch({
        initialEntry: prepared.entry,
        freshEntry: latest,
        cfg: prepared.cfg,
        canonicalSessionKey: prepared.canonicalKey,
        storePath: prepared.storePath,
        resetPolicy: prepared.resetPolicy,
        now: prepared.now,
        requestedSessionId: "original",
        fallbackSessionId: prepared.sessionId,
      });
      expect(mergeSessionEntry(latest, updated.patch)).toMatchObject({
        sessionId: "concurrent",
        sessionStartedAt: prepared.now,
        status: "done",
        lifecycleRunId: "concurrent-run",
        cliSessionIds: { "claude-cli": "native-concurrent" },
      });
    });
  });

  it("refuses a replaced expected session after database admission yields", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {};
      await state.writeConfig(cfg);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:admission-replacement",
        storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
      };
      await upsertSessionEntryCore(scope, { ...freshEntry, sessionId: "original" });
      const open = agentDatabase.withOpenClawAgentDatabaseRuntime;
      const admission = vi
        .spyOn(agentDatabase, "withOpenClawAgentDatabaseRuntime")
        .mockImplementationOnce(async (...args) => {
          await upsertSessionEntryCore(scope, { ...freshEntry, sessionId: "successor" });
          return open(...args);
        });
      const respond = vi.fn();
      try {
        const prepared = await prepareAgentSession({
          cfg,
          requestedSessionKey: scope.sessionKey,
          expectedExistingSessionId: "original",
          request: { message: "continue", idempotencyKey: "admission-replacement" },
          canUseCronRunContinuation: false,
          lifecycleGeneration: "admission-replacement",
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
});
