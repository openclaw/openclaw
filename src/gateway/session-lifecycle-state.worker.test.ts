import "../config/sessions/session-entry-patch-delivery.test-support.js";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { createSessionCompoundWorkerFixture } from "../config/sessions/session-compound-worker.test-support.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

const { getSessionEntryPatchDelivery } =
  await import("../config/sessions/session-entry-patch-delivery.test-support.js");

const routing = vi.hoisted(() => ({ load: vi.fn() }));
// mock-isolation: Fix routing while lifecycle projection, worker commit, and failure appends stay real.
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async () => routing.load(),
}));

it.each(["resumed goal", "another recovery owner"] as const)(
  "commits lifecycle in one request while preserving a queued in-process %s update",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const f = createSessionCompoundWorkerFixture();
      const delivery = getSessionEntryPatchDelivery();
      const generation = getAgentEventLifecycleGeneration();
      const runId = "terminal-run";
      const initial: SessionEntry = {
        ...f.read()!,
        lifecycleRunId: runId,
        startedAt: 1_000,
        updatedAt: 1_000,
      };
      replaceSessionEntrySync(f.scope, initial);
      routing.load.mockReturnValue({
        ...f.scope,
        canonicalKey: f.scope.sessionKey,
        storeKeys: [f.scope.sessionKey],
        entry: initial,
      });
      const goal: NonNullable<SessionEntry["goal"]> = {
        schemaVersion: 1,
        id: "resumed-goal",
        objective: "Finish the work",
        status: "active",
        createdAt: 1_000,
        updatedAt: 3_000,
        tokenStart: 0,
        tokensUsed: 12,
        continuationTurns: 0,
      };
      delivery.beforeCommit = () => {
        delivery.beforeCommit = undefined;
        replaceSessionEntrySync(f.scope, {
          ...initial,
          goal,
          label: "concurrent metadata",
          ...(change === "another recovery owner"
            ? {
                status: "failed",
                restartRecoveryRuns: [
                  { runId, lifecycleGeneration: generation },
                  { runId: "new-owner", lifecycleGeneration: generation },
                ],
                mainRestartRecovery: {
                  cycleId: "recovery-cycle",
                  revision: 2,
                  chargedAttempts: 1,
                  foregroundClaims: {
                    lifecycleGeneration: generation,
                    tokens: ["terminal-claim", "new-claim"],
                    runIdsByClaimId: {
                      "terminal-claim": runId,
                      "new-claim": "new-owner",
                    },
                  },
                },
              }
            : {}),
        });
      };
      const event = {
        ts: 2_000,
        sessionId: initial.sessionId,
        runId,
        data: {
          phase: change === "resumed goal" ? "error" : "end",
          startedAt: 1_000,
          endedAt: 2_000,
          ...(change === "resumed goal" ? { error: "Provider disconnected" } : {}),
        },
      };
      Object.defineProperty(event, "lifecycleGeneration", { value: generation });
      await persistGatewaySessionLifecycleEvent({ sessionKey: f.scope.sessionKey, event });
      expect(
        delivery.commands.filter((command) => command.startsWith("session.entry.patch.")),
      ).toEqual(["session.entry.patch.commit"]);
      expect(f.read()).toMatchObject({ goal, label: "concurrent metadata" });
      if (change === "another recovery owner") {
        expect(f.read()).toMatchObject({
          status: "failed",
          restartRecoveryRuns: [{ runId: "new-owner", lifecycleGeneration: generation }],
          mainRestartRecovery: {
            revision: 3,
            foregroundClaims: {
              tokens: ["new-claim"],
              runIdsByClaimId: { "new-claim": "new-owner" },
            },
          },
        });
        expect(f.events()).not.toContainEqual(
          expect.objectContaining({ customType: "run-failed-before-reply" }),
        );
      } else {
        expect(f.read()).toMatchObject({ status: "failed", lastRunId: runId });
        expect(f.events()).toContainEqual(
          expect.objectContaining({
            type: "custom_message",
            customType: "run-failed-before-reply",
            details: { runId, error: "Provider disconnected" },
          }),
        );
      }
    });
  },
);
