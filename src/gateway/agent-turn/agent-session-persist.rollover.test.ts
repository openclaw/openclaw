import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.operation.js";
import { resolveSessionResetPolicy } from "../../config/sessions/reset-policy.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAgentSessionPatch } from "../server-methods/agent-session-patch.js";
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
      agentId: "main",
      isRestartRecoveryResumeRun: false,
      abortForLifecycleRotation: () => false,
      setMainRestartRecoveryOwnerLease: vi.fn(),
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
      respond: vi.fn(),
    };
    await body(params, profile.id);
  });

it.each([
  { mode: "idle", rejection: undefined, writer: "running" },
  { mode: "daily", rejection: undefined, writer: "running" },
  { mode: "idle", rejection: undefined, writer: "queued" },
  { mode: "daily", rejection: undefined, writer: undefined },
  { mode: "idle", rejection: undefined, writer: "different-session" },
  { mode: "idle", rejection: undefined, writer: "completed" },
  { mode: "idle", rejection: "superseded", writer: undefined },
  { mode: "idle", rejection: "denied", writer: undefined },
  { mode: "daily", rejection: "owner-settled", writer: "running" },
] as const)("$mode reset (rejection: $rejection, writer: $writer)", ({ mode, rejection, writer }) =>
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
          fallbackSessionId: params.runId,
        });
      const turn = writer
        ? createReplyOperation({
            ...target,
            sessionId: writer === "different-session" ? "other-session" : target.sessionId,
            resetTriggered: false,
          })
        : undefined;
      turn?.setPhase(writer === "queued" ? "queued" : "running");
      if (writer === "completed") {
        turn?.complete();
        await turn?.ownerSettlement;
      }
      params.initialPatchBuild = await params.buildSessionPatch(entry);
      if (rejection === "owner-settled") {
        turn?.complete();
        await turn?.ownerSettlement;
      } else if (rejection === "superseded") {
        await replaceSessionEntry(target, { ...entry, lifecycleRevision: "newer-reset" });
      } else if (rejection === "denied") {
        params.request.deliver = true;
        params.cfg.session = { sendPolicy: { default: "deny" } };
      }
      let result: Awaited<ReturnType<typeof persistAgentSessionPhase>>;
      try {
        result = await persistAgentSessionPhase(params);
        expect(turn?.abortSignal.aborted).not.toBe(true);
      } finally {
        turn?.complete();
        await turn?.ownerSettlement;
      }
      const reset = !rejection && writer !== "running";
      await appendTranscriptMessage(target, { message: makeUserMessage("After: COBALT942", now) });
      const events = await loadTranscriptEvents(target);
      expect(events.filter((event) => isRecord(event) && event.type === "reset")).toEqual(
        reset ? [expect.objectContaining({ reason: mode })] : [],
      );
      expect(events.filter((event) => isRecord(event) && event.type === "message")).toMatchObject([
        { message: { content: "Before: AMBER731" } },
        { message: { content: "After: COBALT942" } },
      ]);
      if (rejection) {
        expect(result).toBeUndefined();
        expect(params.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: rejection === "denied" ? "INVALID_REQUEST" : "UNAVAILABLE",
          }),
        );
        return;
      }
      expect(result?.sessionEntry).toMatchObject({
        sessionId: target.sessionId,
        sessionStartedAt: reset ? now : expiredAt,
      });
      expect(result?.sessionEntry?.lifecycleRevision === entry.lifecycleRevision).toBe(!reset);
    },
  ),
);
