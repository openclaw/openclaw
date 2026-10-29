import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import * as cleanup from "../../auto-reply/reply/session-reset-cleanup.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { resolveSessionResetPolicy } from "../../config/sessions/reset-policy.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAgentSessionPatch } from "../server-methods/agent-session-patch.js";
import * as resetHooks from "../session-reset-service.js";
import { persistAgentSessionPhase } from "./agent-session-persist.js";

type Params = Parameters<typeof persistAgentSessionPhase>[0];

async function withFixture(
  mode: "idle" | "daily",
  run: (
    params: Params,
    target: { agentId: string; sessionKey: string; sessionId: string; storePath: string },
  ) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    const now = new Date(2026, 9, 20, 12).getTime();
    const expiredAt = new Date(2026, 9, 19, 12).getTime();
    const target = {
      agentId: "main",
      sessionKey: "agent:main:automatic-reset",
      sessionId: "durable-transcript",
      storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
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
    const buildSessionPatch: Params["buildSessionPatch"] = (freshEntry) =>
      buildAgentSessionPatch({
        freshEntry,
        initialEntry: entry,
        cfg: {},
        sessionAgentId: "main",
        canonicalSessionKey: target.sessionKey,
        storePath: target.storePath,
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
        fallbackSessionId: "replacement",
        touchInteraction: true,
      });
    const params: Params = {
      request: { message: "continue", idempotencyKey: "reset-run" },
      cfg: {},
      storePath: target.storePath,
      entry,
      canonicalSessionKey: target.sessionKey,
      sessionAgentId: "main",
      mainSessionKey: "agent:main:main",
      creation: { via: "run" },
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      isRestartRecoveryResumeRun: false,
      runId: "reset-run",
      agentId: "main",
      suppressVisibleSessionEffects: false,
      initialPatchBuild: await buildSessionPatch(entry),
      buildSessionPatch,
      state: {
        sessionEntry: entry,
        resolvedSessionId: target.sessionId,
        sessionPersistedBeforeGatewayAdmission: false,
        admittedSessionId: target.sessionId,
        skipAgentInitialSessionTouch: false,
        isNewSession: true,
        bestEffortDeliver: false,
      },
      touchInteraction: true,
      expectedSession: undefined,
      maintenanceConfig: undefined,
      abortForLifecycleRotation: () => false,
      assertGatewayWorkAdmissionAllowed: () => {},
      respondToGatewayAdmissionOutcome: () => false,
      setCronContinuationClaim: () => {},
      setMainRestartRecoveryOwnerLease: () => {},
      respond: vi.fn(),
    };
    await run(params, target);
  });
}

describe("Gateway automatic reset atomic lifecycle", () => {
  it.each(["idle", "daily"] as const)(
    "keeps the %s transcript and closes only the old interval",
    async (mode) => {
      const end = vi
        .spyOn(resetHooks, "emitGatewaySessionEndPluginHook")
        .mockImplementation(() => {});
      const clean = vi.spyOn(cleanup, "clearCommittedSessionResetRuntimeState");
      try {
        await withFixture(mode, async (params, target) => {
          const result = await persistAgentSessionPhase(params);
          expect(result?.sessionEntry).toMatchObject({
            sessionId: target.sessionId,
            sessionStartedAt: new Date(2026, 9, 20, 12).getTime(),
          });
          expect(result?.sessionEntry?.lifecycleRevision).not.toBe("before-expiry");
          await appendTranscriptMessage(target, {
            message: makeUserMessage("After: COBALT942", Date.now()),
          });
          const events = await loadTranscriptEvents(target);
          expect(events.filter((event) => isRecord(event) && event.type === "reset")).toEqual([
            expect.objectContaining({ reason: mode }),
          ]);
          expect(
            events.filter((event) => isRecord(event) && event.type === "message"),
          ).toHaveLength(2);
          expect(end).toHaveBeenCalledOnce();
          expect(clean).toHaveBeenCalledOnce();
          const endedTranscript = end.mock.calls[0]?.[0].endedTranscript;
          if (!endedTranscript?.available) {
            throw new Error("Expected an available closed transcript interval");
          }
          const closed = await endedTranscript.readTail({
            maxMessages: 20,
            maxBytes: 65536,
          });
          expect(JSON.stringify(closed)).toContain("AMBER731");
          expect(JSON.stringify(closed)).not.toContain("COBALT942");
        });
      } finally {
        end.mockRestore();
        clean.mockRestore();
      }
    },
  );

  it.each(["stale", "denied", "authority", "cron"] as const)(
    "refuses %s without a boundary or cleanup",
    async (rejection) => {
      const clean = vi.spyOn(cleanup, "clearCommittedSessionResetRuntimeState");
      const end = vi
        .spyOn(resetHooks, "emitGatewaySessionEndPluginHook")
        .mockImplementation(() => {});
      try {
        await withFixture("idle", async (params, target) => {
          if (rejection === "stale") {
            await replaceSessionEntry(target, {
              ...params.entry!,
              lifecycleRevision: "newer-reset",
            });
          }
          if (rejection === "denied") {
            params.request.deliver = true;
            params.cfg.session = { sendPolicy: { default: "deny" } };
          }
          if (rejection === "authority") {
            params.assertAdmissionCurrent = () => {
              throw new Error("authority revoked");
            };
          }
          if (rejection === "cron") {
            params.restoredCronContinuationIdentity = {
              sessionId: target.sessionId,
              lifecycleRevision: "missing-cron-marker",
            };
          }
          if (rejection === "authority") {
            await expect(persistAgentSessionPhase(params)).rejects.toThrow("authority revoked");
          } else {
            expect(await persistAgentSessionPhase(params)).toBeUndefined();
          }
          expect(
            (await loadTranscriptEvents(target)).filter(
              (event) => isRecord(event) && event.type === "reset",
            ),
          ).toEqual([]);
          expect(loadSessionEntry(target)?.lifecycleRevision).toBe(
            rejection === "stale" ? "newer-reset" : "before-expiry",
          );
          expect(clean).not.toHaveBeenCalled();
          expect(end).not.toHaveBeenCalled();
        });
      } finally {
        clean.mockRestore();
        end.mockRestore();
      }
    },
  );

  it("admits only one concurrent reset for the captured lifecycle", async () => {
    const clean = vi.spyOn(cleanup, "clearCommittedSessionResetRuntimeState");
    const end = vi
      .spyOn(resetHooks, "emitGatewaySessionEndPluginHook")
      .mockImplementation(() => {});
    try {
      await withFixture("idle", async (params, target) => {
        const competitor = { ...params, state: { ...params.state } };
        const results = await Promise.all([
          persistAgentSessionPhase(params),
          persistAgentSessionPhase(competitor),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(
          (await loadTranscriptEvents(target)).filter(
            (event) => isRecord(event) && event.type === "reset",
          ),
        ).toHaveLength(1);
        expect(clean).toHaveBeenCalledOnce();
        expect(end).toHaveBeenCalledOnce();
      });
    } finally {
      clean.mockRestore();
      end.mockRestore();
    }
  });
});
