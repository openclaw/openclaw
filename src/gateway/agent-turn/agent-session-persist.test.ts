import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { resolveSessionResetPolicy } from "../../config/sessions/reset-policy.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAgentSessionPatch } from "../server-methods/agent-session-patch.js";
import { withSessionSendDelivery } from "../session-send-delivery.js";
import { persistAgentSessionPhase } from "./agent-session-persist.js";

type PersistParams = Parameters<typeof persistAgentSessionPhase>[0];
const withPersistFixture = (
  role: GatewayOperatorRoleDefinition,
  body: (params: PersistParams, profileId: string) => Promise<void>,
) =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async (state) => {
    const profile = ensureProfileForEmail("session-creator@example.com");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
    const runId = "session-run";
    const params: PersistParams = {
      runId,
      storePath,
      canonicalSessionKey: "agent:main:test",
      operatorRoleActor: { kind: "operator", profileId: profile.id },
      cfg: { gateway: { roles: { default: "test", definitions: { test: role } } } },
      request: { message: "sandboxed", idempotencyKey: runId },
      sessionAgentId: "main",
      mainSessionKey: "agent:main:main",
      creation: { via: "run" },
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      isRestartRecoveryResumeRun: false,
      agentId: "main",
      suppressVisibleSessionEffects: false,
      initialPatchBuild: {
        patch: { sessionId: runId, updatedAt: 1 },
        spawnedBy: undefined,
        groupId: undefined,
        groupChannel: undefined,
        groupSpace: undefined,
        freshSessionRotatedSinceLoad: false,
        isNewSession: true,
        rotatedSessionId: false,
        usableRequestedSessionId: undefined,
        freshness: undefined,
      },
      buildSessionPatch: async () => params.initialPatchBuild,
      state: {
        sessionPersistedBeforeGatewayAdmission: false,
        admittedSessionId: runId,
        skipAgentInitialSessionTouch: false,
        isNewSession: true,
        bestEffortDeliver: false,
      },
      touchInteraction: false,
      expectedSession: undefined,
      maintenanceConfig: undefined,
      assertGatewayWorkAdmissionAllowed: vi.fn(),
      respondToGatewayAdmissionOutcome: () => false,
      setCronContinuationClaim: vi.fn(),
      setMainRestartRecoveryOwnerLease: vi.fn(),
      respond: vi.fn(),
    };
    await body(params, profile.id);
  });

it.each([false, true])(
  "sandboxes a synthetic run and preserves interrupted recovery ownership (queued peer: %s)",
  (queuedPeer) =>
    withPersistFixture(
      {
        sessions: { others: "view" },
        agents: ["main"],
        scopes: ["operator.write"],
        sandbox: "required",
      },
      async (params, profileId) => {
        const { runId, canonicalSessionKey: sessionKey, storePath } = params;
        const target = { agentId: "main", sessionKey, storePath };
        const sql = observeHostDataSql();
        const committed = vi.fn((entry: { sessionId: string }) => {
          sql.restore();
          expect(loadSessionEntry(target)?.sessionId).toBe(entry.sessionId);
        });
        const setMainRestartRecoveryOwnerLease = vi.fn();
        params.onSessionCommitted = committed;
        params.setMainRestartRecoveryOwnerLease = setMainRestartRecoveryOwnerLease;
        const result = await persistAgentSessionPhase(params).finally(sql.restore);

        expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
        expect(result?.sessionEntry).toMatchObject({
          createdVia: "run",
          createdActor: { type: "human", id: profileId },
          sandbox: "required",
        });
        expect(committed).toHaveBeenCalledOnce();
        expect(loadSessionEntry(target)).toMatchObject({ sandbox: "required" });

        assert(result?.sessionEntry, "Fixture requires a persisted session");
        const interruptedRun = {
          runId: "interrupted-before-send",
          lifecycleGeneration: "previous-generation",
        };
        const interrupted = {
          ...result.sessionEntry,
          abortedLastRun: true,
          restartRecoveryRuns: [interruptedRun],
        };
        await replaceSessionEntry(target, interrupted);
        const resumedPatch = { ...params.initialPatchBuild, isNewSession: false };
        const persist = () =>
          persistAgentSessionPhase({
            ...params,
            onSessionCommitted: undefined,
            entry: interrupted,
            initialPatchBuild: resumedPatch,
            buildSessionPatch: async () => resumedPatch,
            state: { ...result, sessionEntry: interrupted, isNewSession: false },
          });
        if (queuedPeer) {
          await withSessionSendDelivery(
            {
              delivery: {
                version: 1,
                runId,
                source: {
                  agentId: "main",
                  sessionKey: "agent:main:sender",
                  sessionId: "sender-session",
                },
                target: { agentId: "main", sessionKey, sessionId: interrupted.sessionId },
                sandboxed: true,
                message: "sandboxed",
              },
            },
            persist,
          );
        } else {
          await persist();
        }
        const current = loadSessionEntry(target);
        expect(current?.restartRecoveryRuns).toContainEqual(interruptedRun);
        if (queuedPeer) {
          expect(current?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
          expect(current?.restartRecoveryRuns).toEqual([interruptedRun]);
          expect(setMainRestartRecoveryOwnerLease).not.toHaveBeenCalled();
        } else {
          expect(
            Object.values(current?.mainRestartRecovery?.foregroundClaims?.runIdsByClaimId ?? {}),
          ).toContain(runId);
          expect(setMainRestartRecoveryOwnerLease).toHaveBeenCalledOnce();
        }
      },
    ),
);

it.each([false, true])(
  "surfaces creation denial when role authority forbids the agent (revoked during preparation: %s)",
  async (revokeDuringPreparation) => {
    const allowedAgents = revokeDuringPreparation ? ["main"] : [];
    await withPersistFixture(
      { sessions: { others: "none" }, agents: allowedAgents, scopes: [] },
      async (params) => {
        const respond = vi.fn<PersistParams["respond"]>();
        params.respond = respond;
        params.buildSessionPatch = async () => {
          await Promise.resolve();
          allowedAgents.length = 0;
          return params.initialPatchBuild;
        };
        await expect(persistAgentSessionPhase(params)).resolves.toBeUndefined();

        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "FORBIDDEN",
            message: expect.stringContaining('agent "main"'),
          }),
        );
      },
    );
  },
);

it.each([
  { mode: "idle", rejection: undefined },
  { mode: "daily", rejection: undefined },
  { mode: "idle", rejection: "superseded" },
  { mode: "idle", rejection: "denied" },
] as const)("handles a $mode Gateway reset (rejection: $rejection)", ({ mode, rejection }) =>
  withPersistFixture(
    { sessions: { others: "view" }, agents: ["main"], scopes: [] },
    async (params) => {
      const now = new Date(2026, 9, 20, 12).getTime();
      const expiredAt = new Date(2026, 9, 19, 12).getTime();
      const target = {
        agentId: "main",
        sessionKey: params.canonicalSessionKey,
        sessionId: "durable-transcript",
        storePath: params.storePath,
      };
      const entry = {
        sessionId: target.sessionId,
        lifecycleRevision: "before-expiry",
        updatedAt: expiredAt,
        sessionStartedAt: expiredAt,
        lastInteractionAt: expiredAt,
      };
      await replaceSessionEntry(target, entry);
      await appendTranscriptMessage(target, {
        message: makeUserMessage("Before: AMBER731", expiredAt),
      });
      await replaceSessionEntry(target, entry);
      params.entry = entry;
      params.buildSessionPatch = (freshEntry) =>
        buildAgentSessionPatch({
          ...params,
          freshEntry,
          initialEntry: entry,
          normalizedSpawned: {},
          requestDeliveryHint: undefined,
          hasRestoredCronContinuation: false,
          resetPolicy: resolveSessionResetPolicy({
            sessionCfg: { reset: mode === "idle" ? { mode, idleMinutes: 1 } : { mode, atHour: 4 } },
            resetType: "direct",
          }),
          now,
          isSystemGatewayRun: false,
          visibleRequest: true,
          touchInteraction: true,
        });
      params.initialPatchBuild = await params.buildSessionPatch(entry);
      if (rejection === "superseded") {
        await replaceSessionEntry(target, { ...entry, lifecycleRevision: "newer-reset" });
      } else if (rejection === "denied") {
        params.request.deliver = true;
        params.cfg.session = { sendPolicy: { default: "deny" } };
      }
      const result = await persistAgentSessionPhase(params);
      if (rejection) {
        expect(result).toBeUndefined();
        expect(params.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: rejection === "superseded" ? "UNAVAILABLE" : "INVALID_REQUEST",
          }),
        );
        expect(
          (await loadTranscriptEvents(target)).filter(
            (event) => isRecord(event) && event.type === "reset",
          ),
        ).toEqual([]);
        return;
      }
      expect(result?.sessionEntry).toMatchObject({
        sessionId: target.sessionId,
        sessionStartedAt: now,
      });
      expect(result?.sessionEntry?.lifecycleRevision).not.toBe(entry.lifecycleRevision);
      await appendTranscriptMessage(target, { message: makeUserMessage("After: COBALT942", now) });
      const events = await loadTranscriptEvents(target);
      expect(events.filter((event) => isRecord(event) && event.type === "reset")).toEqual([
        expect.objectContaining({ reason: mode }),
      ]);
      expect(events.filter((event) => isRecord(event) && event.type === "message")).toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "Before: AMBER731" }),
        }),
        expect.objectContaining({
          message: expect.objectContaining({ content: "After: COBALT942" }),
        }),
      ]);
    },
  ),
);
