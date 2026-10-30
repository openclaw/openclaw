import "../config/sessions/session-entry-patch-delivery.test-support.js";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { buildCreatedSessionGoal } from "../config/sessions/goals-transitions.js";
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
        details: { runId, error: "Provider disconnected" },
      }),
    );
  }));
