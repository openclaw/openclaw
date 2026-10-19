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
import { setAppliedRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import { createSubscriptionTestFixture } from "./server-runtime-subscriptions.test-support.js";
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
    unsubs.heartbeatUnsub();
    unsubs.transcriptUnsub();
    unsubs.lifecycleUnsub();
    resetProcessRegistryForTests();
  }
});

it.for([
  { phase: "before startup", completion: "physical" },
  { phase: "before inherited connection drain", completion: "physical" },
  { phase: "before inherited connection drain", completion: "logical" },
] as const)(
  "cancels auxiliary model work $phase after $completion completion",
  async ({ phase, completion }, { signal }) => {
    let unsubs: ReturnType<typeof startGatewayEventSubscriptions> | undefined;
    const testState = await createOpenClawTestState({ scenario: "minimal" });
    const connectionWork = new GatewayConnectionWork();
    const target = { key: "agent:main:shutdown-recap", agentId: "main" };
    const scope = {
      sessionKey: target.key,
      agentId: target.agentId,
      sessionId: "shutdown-recap",
    };
    const started = createDeferred();
    const finish = createDeferred();
    const released = vi.fn();
    const prepared = vi.spyOn(sessionObserverModel, "defaultPrepareModel").mockResolvedValue({
      config: {},
      authProfileId: undefined,
      provider: "test",
      model: "utility",
      agentId: "main",
      agentDir: testState.path("agent"),
      outputTextPolicy: "strict-visible",
      thinkLevel: "off",
    });
    const complete = vi.spyOn(sessionObserverModel, "defaultCompleteModel").mockImplementation(() =>
      runWithAsyncWorkResources(async (onAcquired) => {
        onAcquired({ release: released });
        const physical = trackAsyncWork(async () => {
          started.resolve();
          await finish.promise;
        });
        if (completion === "physical") {
          await physical;
        }
        return {
          text: "Finished.",
          provider: "test",
          model: "utility",
          owner: { kind: "harness", id: "test" },
        };
      }),
    );
    let draining: Promise<void> | undefined;
    try {
      runtimeConfigState.value = { agents: { defaults: { utilityModel: "test/utility" } } };
      await setAppliedRuntimeConfigSnapshot(runtimeConfigState.value, runtimeConfigState.value);
      const entry = await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
      });
      await persistSessionTranscriptTurn(scope, {
        messages: Array.from({ length: 70 }, (_, index) => ({
          eventId: `shutdown-message-${index}`,
          message: { role: "user", content: `Work ${index}` },
        })),
        touchSessionEntry: false,
      });
      if (phase === "before startup") {
        connectionWork.beginClose();
      }
      unsubs = startGatewayEventSubscriptions({
        ...createSubscriptionTestFixture().createParams(),
        signal: connectionWork.signal,
        log: createSubsystemLogger("test/subscriptions-shutdown"),
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
      const modelSignal = complete.mock.calls[0]![0].abortSignal!;
      let drained = false;
      draining = connectionWork.drain().then(() => {
        drained = true;
      });
      expect(modelSignal.aborted).toBe(true);
      await nextTurn();
      expect(drained).toBe(false);
      expect(released).not.toHaveBeenCalled();
      finish.resolve();
      await draining;
      await unsubs.agentUnsub();
      expect(released).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledOnce();
      expect(loadSessionEntryReadOnly(scope)?.activitySummary).toBeUndefined();
    } finally {
      finish.resolve();
      await unsubs?.agentUnsub();
      unsubs?.heartbeatUnsub();
      unsubs?.transcriptUnsub();
      unsubs?.lifecycleUnsub();
      unsubs = undefined;
      await draining;
      prepared.mockRestore();
      complete.mockRestore();
      await testState.cleanup();
    }
  },
);
