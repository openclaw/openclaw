import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  addSession,
  appendOutput,
  deleteSession,
  markBackgrounded,
  markExited,
} from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import * as utilityCompletion from "../agents/utility-completion.js";
import { setAppliedRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { heartbeatNotifications } from "../infra/heartbeat-events.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import { createSubscriptionTestFixture } from "./server-runtime-subscriptions.test-support.js";
import {
  activityRecapResult,
  messages,
  preparedActivityRecapModel,
  scope,
  target,
} from "./session-activity-summaries.test-support.js";
import * as sessionObserverModel from "./session-observer-model.js";

const runtimeConfigState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
// mock-isolation: Subscription and transcript readers share the fixture config without live file I/O.
vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => runtimeConfigState.value,
  getRuntimeConfigSnapshot: () => runtimeConfigState.value,
}));
vi.mock("../audit/audit-recorder.js", () => ({
  createAuditEventRecorder: () => ({
    record: vi.fn(),
    recordTool: vi.fn(),
    recordMessage: vi.fn(),
    recordExecutionIdentity: vi.fn(),
    recordExecutionDecision: vi.fn(),
    stop: vi.fn(async () => {}),
  }),
}));

it("coalesces background process changes without invalidating session rows and stops on disposal", async () => {
  vi.useFakeTimers();
  const params = createSubscriptionTestFixture().createParams();
  const unsubs = startGatewayEventSubscriptions(params);
  try {
    const process = createProcessSessionFixture({ id: "build" });
    process.scopeKey = "agent:main:process-owner";
    process.agentId = "main";
    addSession(process);
    appendOutput(process, "stdout", "Starting");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(params.broadcast).not.toHaveBeenCalled();
    markBackgrounded(process);
    for (let index = 0; index < 20; index++) {
      appendOutput(process, "stdout", "More output");
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(params.broadcast).toHaveBeenCalledExactlyOnceWith(
      "sessions.processes.changed",
      { sessionKey: process.scopeKey, agentId: "main" },
      { sessionKeys: [process.scopeKey], agentId: "main", dropIfSlow: true },
    );
    markExited(process, 0, null, "completed");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(params.broadcast).toHaveBeenCalledTimes(2);
    deleteSession(process.id);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(params.broadcast).toHaveBeenCalledTimes(3);
    const later = createProcessSessionFixture({ id: "later-build", backgrounded: true });
    later.scopeKey = process.scopeKey;
    later.agentId = "main";
    addSession(later);
    unsubs.lifecycleUnsub();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(params.broadcast).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
    await unsubs.agentUnsub();
    heartbeatNotifications.onEvent = () => {};
    unsubs.transcriptUnsub();
    unsubs.lifecycleUnsub();
    resetProcessRegistryForTests();
  }
});

// Logical completion before physical settlement is covered by the recap owner's retry suite.
it.for(["before startup", "before inherited connection drain"])(
  "cancels auxiliary model work %s",
  async (phase, { signal }) => {
    let unsubs: ReturnType<typeof startGatewayEventSubscriptions> | undefined;
    const testState = await createOpenClawTestState({ scenario: "minimal" });
    const connectionWork = new GatewayConnectionWork();
    const started = createDeferred();
    const finish = createDeferred();
    using auth = vi.spyOn(utilityCompletion, "hasAvailableUtilityCompletionAuth");
    auth.mockResolvedValue(true);
    using prepared = vi.spyOn(sessionObserverModel, "defaultPrepareModel").mockResolvedValue({
      ...preparedActivityRecapModel,
      agentDir: testState.path("agent"),
    });
    using complete = vi
      .spyOn(sessionObserverModel, "defaultCompleteModel")
      .mockImplementation(async () => {
        started.resolve();
        await finish.promise;
        return activityRecapResult("Finished.");
      });
    let draining: Promise<void> | undefined;
    try {
      runtimeConfigState.value = { agents: { defaults: { utilityModel: "test/utility" } } };
      await setAppliedRuntimeConfigSnapshot(runtimeConfigState.value, runtimeConfigState.value);
      const entry = await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
      });
      await messages(70);
      if (phase === "before startup") {
        connectionWork.beginClose();
      }
      unsubs = startGatewayEventSubscriptions({
        ...createSubscriptionTestFixture().createParams(),
        signal: connectionWork.signal,
      });
      if (phase === "before startup") {
        expect(
          (await unsubs.sessionActivitySummaries.ensure(target, entry ?? undefined)).state,
        ).toBe("unavailable");
        expect(prepared).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
        return;
      }
      await connectionWork.track(() =>
        unsubs!.sessionActivitySummaries.ensure(target, entry ?? undefined),
      );
      // ensure returns a projection before the real transcript worker reaches the model.
      await withinTest(started.promise, signal);
      expect(complete).toHaveBeenCalledOnce();
      let drained = false;
      draining = connectionWork.drain().then(() => {
        drained = true;
      });
      expect(complete.mock.calls[0]![0].abortSignal?.aborted).toBe(true);
      await nextTurn();
      expect(drained).toBe(false);
      finish.resolve();
      await draining;
      await unsubs.agentUnsub();
      expect(loadSessionEntryReadOnly(scope)?.activitySummary).toBeUndefined();
    } finally {
      finish.resolve();
      await unsubs?.agentUnsub();
      heartbeatNotifications.onEvent = () => {};
      unsubs?.transcriptUnsub();
      unsubs?.lifecycleUnsub();
      await draining;
      await testState.cleanup();
    }
  },
);
