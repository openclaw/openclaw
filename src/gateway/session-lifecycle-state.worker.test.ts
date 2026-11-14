import "../config/sessions/session-entry-patch-delivery.test-support.js";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { buildCreatedSessionGoal } from "../config/sessions/goals-transitions.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { createSessionCompoundWorkerFixture } from "../config/sessions/session-compound-worker.test-support.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

const { getSessionEntryPatchDelivery } =
  await import("../config/sessions/session-entry-patch-delivery.test-support.js");

const routing = vi.hoisted(() => ({ load: vi.fn() }));
// mock-isolation: Fix routing while lifecycle projection, worker commit, and failure appends stay real.
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async () => routing.load(),
}));

it("commits lifecycle in one request while preserving a queued goal update", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
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
    routing.load.mockReturnValue({ ...f.scope, ...f.target, entry: initial });
    const goal = {
      ...buildCreatedSessionGoal(initial, { objective: "Finish the work" }, 1_000),
      updatedAt: 3_000,
      tokensUsed: 12,
    };
    const queued: SessionEntry = { ...initial, goal, label: "concurrent metadata" };
    delivery.beforeCommit = () => {
      delivery.beforeCommit = undefined;
      replaceSessionEntrySync(f.scope, queued);
    };
    const event = {
      ts: 2_000,
      sessionId: initial.sessionId,
      runId,
      data: {
        phase: "error",
        startedAt: 1_000,
        endedAt: 2_000,
        error: "Provider disconnected",
        desktopErrorNotice: "Provider disconnected. Try again shortly.",
      },
    };
    Object.defineProperty(event, "lifecycleGeneration", { value: generation });
    await persistGatewaySessionLifecycleEvent({ sessionKey: f.scope.sessionKey, event });
    expect(
      delivery.commands.filter((command) => command.startsWith("session.entry.patch.")),
    ).toEqual(["session.entry.patch.commit"]);
    expect(f.read()).toMatchObject({ goal, label: "concurrent metadata" });
    expect(f.read()).toMatchObject({ status: "failed", lastRunId: runId });
    expect(f.events()).toContainEqual(
      expect.objectContaining({
        type: "custom_message",
        customType: "run-failed-before-reply",
        content: "Your request couldn't be completed.",
        details: {
          runId,
          error: "Provider disconnected",
          desktopNotice: "Provider disconnected. Try again shortly.",
        },
      }),
    );
  }));

it("retains missed shutdown markers in terminal writes without marking resets or other owners", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const f = createSessionCompoundWorkerFixture();
    const retained = { queuedInputIds: ["accepted-input"], hadBackgroundExec: true as const };
    const cases: Array<{
      name: string;
      key?: string;
      shutdown?: boolean;
      stopReason?: string;
      stale?: boolean;
      unstarted?: boolean;
      unstartedRunId?: string;
      entry?: Partial<SessionEntry>;
      marker?: SessionEntry["resumeAfterRestart"];
    }> = [
      { name: "missing", shutdown: true, marker: { queuedInputIds: [] } },
      { name: "queued", shutdown: true, entry: { resumeAfterRestart: retained }, marker: retained },
      { name: "reset" },
      { name: "stop", shutdown: true, stopReason: "aborted" },
      { name: "stale", shutdown: true, stale: true },
      { name: "unstarted", shutdown: true, unstarted: true },
      {
        name: "accepted-before-execution",
        shutdown: true,
        unstarted: true,
        unstartedRunId: "running",
        marker: { queuedInputIds: [] },
      },
      { name: "cron", shutdown: true, key: "agent:main:cron:scheduled" },
      { name: "child", shutdown: true, key: "agent:main:subagent:child" },
      { name: "external", shutdown: true, entry: { modelSelectionLocked: true } },
      { name: "archived", shutdown: true, entry: { archivedAt: 1_500 } },
    ];
    try {
      for (const test of cases) {
        resetGatewayWorkAdmission();
        const scope = { ...f.scope, sessionKey: test.key ?? `agent:main:${test.name}` };
        const initial: SessionEntry = {
          sessionId: scope.sessionId,
          lifecycleRunId: "running",
          startedAt: 1_000,
          updatedAt: 1_000,
          ...test.entry,
        };
        replaceSessionEntrySync(scope, initial);
        if (test.entry?.resumeAfterRestart) {
          replaceSessionEntrySync(scope, initial);
          expect(loadExactSessionEntry(scope)?.entry.resumeAfterRestart).toEqual(retained);
        }
        routing.load.mockReturnValue({
          ...scope,
          canonicalKey: scope.sessionKey,
          storeKeys: [scope.sessionKey],
          entry: initial,
        });
        if (test.shutdown) {
          markGatewayRestartDraining();
        }
        await persistGatewaySessionLifecycleEvent({
          sessionKey: scope.sessionKey,
          event: {
            runId: test.unstarted ? (test.unstartedRunId ?? "queued") : "running",
            sessionId: test.stale ? "replaced-session" : scope.sessionId,
            ts: 2_000,
            data: {
              phase: "end",
              aborted: true,
              stopReason: test.stopReason ?? "restart",
              ...(test.unstarted ? { executionStarted: false } : {}),
            },
          },
        });
        expect(loadExactSessionEntry(scope)?.entry.resumeAfterRestart, test.name).toEqual(
          test.marker,
        );
      }
    } finally {
      resetGatewayWorkAdmission();
    }
  }));
