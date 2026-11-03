import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginReloadRunTarget } from "../agents/plugin-reload-runs.js";
import type { SessionEventOutcome } from "../auto-reply/reply/session-event-contract.js";
import { invalidateSessionRunStopIntents } from "../sessions/session-run-stopped.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { PluginReloadOperation } from "./plugin-reload-operation-store.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const h = vi.hoisted(() => ({
  operations: new Map<string, PluginReloadOperation>(),
  loaded: vi.fn(),
  captureQueue: vi.fn(),
  captureTarget: vi.fn(),
  entries: vi.fn(),
  pendingRead: vi.fn(),
  continueQueue: vi.fn(),
  restore: vi.fn(),
  enqueue: vi.fn(),
  recoverySource: {
    kind: "unavailable",
  } as PluginReloadOperation["continuations"][number]["recoverySource"],
  saveGate: undefined as Promise<void> | undefined,
}));
vi.mock("./plugin-reload-operation-store.js", () => ({
  readPluginReloadOperation: async (id: string) => structuredClone(h.operations.get(id)),
  listPluginReloadOperations: async () => structuredClone([...h.operations.values()]),
  savePluginReloadOperation: async (value: PluginReloadOperation) => {
    await h.saveGate;
    h.operations.set(value.id, structuredClone(value));
  },
}));
vi.mock("./session-utils-store.js", () => ({ loadGatewaySessionEntryReadOnlyAsync: h.loaded }));
vi.mock("../config/sessions/session-pending-input-history.js", () => ({
  captureSessionQueuedInputsForRestart: h.captureQueue,
}));
vi.mock("../sessions/session-controller.lifecycle-projections.js", () => ({
  matchingEntries: h.entries,
}));

vi.mock("./operator-run-recovery-source.js", () => ({
  captureQueuedOperatorRecoverySource: () => h.recoverySource,
}));
vi.mock("./operator-run-recovery.js", () => ({ restoreGatewayQueuedOperatorRecovery: h.restore }));
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: h.captureTarget,
  enqueueSessionEventForHost: h.enqueue,
}));
vi.mock("./queued-chat-inputs.js", () => ({ continueSessionQueuedInputs: h.continueQueue }));
vi.mock("../config/sessions/session-pending-input-store.js", () => ({
  preparePendingInputStore: async () => ({ read: h.pendingRead, release: async () => {} }),
}));
import {
  pluginReloadContinuationSourceId,
  preparePluginReloadContinuations,
  resumePluginReloadContinuations,
} from "./plugin-reload-continuations.js";

function context() {
  return { logGateway: { warn: vi.fn() } } as unknown as GatewayRequestContext;
}
function target(sessionKey = "agent:main:chat") {
  return {
    agentId: "main",
    sessionId: "session-1",
    sessionKey,
    runId: "old-run",
    sourceInputKeys: ["old-run:user"],
    isBlocking: () => true,
    operation: { result: null, abortSignal: new AbortController().signal },
    interrupt: vi.fn(),
  } as unknown as PluginReloadRunTarget;
}
function operation(): PluginReloadOperation {
  return {
    id: "reload-1",
    pluginIds: ["proof"],
    state: "reloading",
    createdAtMs: 1,
    updatedAtMs: 1,
    continuations: [
      {
        agentId: "main",
        sessionKey: "agent:main:chat",
        sessionId: "session-1",
        lifecycleRevision: "revision",
        sourceRunId: "old-run",
        sourceInputKeys: ["old-run:user"],
        recoverySource: { kind: "unavailable" },
        queuedInputIds: ["q1"],
        state: "pending",
      },
    ],
  };
}
beforeEach(() => {
  h.operations.clear();
  h.saveGate = undefined;
  vi.clearAllMocks();
});
describe("plugin reload continuation owner", () => {
  it("persists continuation intent before preserving queue custody or disrupting the run", async () => {
    const run = target();
    const preserve = vi.fn();
    h.loaded.mockResolvedValue({
      storePath: "/proof",
      entry: { sessionId: "session-1", lifecycleRevision: "revision" },
    });
    h.entries.mockReturnValue([
      {
        mailbox: {
          entries: [
            {
              claim: { operation: run.operation },
              source: { operatorAuthority: { assertCurrent: vi.fn() } },
            },
          ],
        },
      },
    ]);
    h.recoverySource = {
      kind: "gateway",
      snapshot: {
        profileId: "operator",
        controlUiAdmin: false,
        localOperator: true,
        sourceIngress: "control-ui",
        scopes: ["operator.write"],
        assignedRole: "admin",
        githubLogin: null,
        grant: null,
        aliasBindingIds: [],
        authPolicy: {
          generation: "",
          grantGeneration: "test",
          role: "operator",
          authMethod: "token",
        },
      },
    };
    h.captureQueue.mockResolvedValue({ queuedInputIds: ["q1"], preserve });

    let finish!: () => void;
    h.saveGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending = preparePluginReloadContinuations([run], context(), () => {}, {
      id: "durability",
      pluginIds: ["proof"],
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(preserve).not.toHaveBeenCalled();
    finish();
    const saved = await pending;
    expect(saved.continuations[0]?.lifecycleRevision).toBe("revision");
    expect(h.operations.get("durability")?.continuations[0]?.queuedInputIds).toEqual(["q1"]);
    expect(preserve).toHaveBeenCalledOnce();
    expect(run.interrupt).not.toHaveBeenCalled();
    h.recoverySource = { kind: "unavailable" };
  });
  it.each(["agent:main:cron:job", "agent:main:acp:task", "agent:main:subagent:child"])(
    "rejects unsupported %s before journal or disruption",
    async (key) => {
      const run = target(key);
      await expect(
        preparePluginReloadContinuations([run], context(), () => {}, { pluginIds: ["proof"] }),
      ).rejects.toThrow("only normal native conversations");
      expect(h.operations.size).toBe(0);
      expect(run.interrupt).not.toHaveBeenCalled();
      expect(h.captureQueue).not.toHaveBeenCalled();
    },
  );
  it("does not wake completed replies retained by raw cleanup", async () => {
    h.loaded.mockResolvedValue({
      storePath: "/proof",
      entry: { sessionId: "session-1", lifecycleRevision: "revision" },
    });
    const run = target();
    Object.assign(run.operation!, { result: { status: "completed" } });
    const accepted = await preparePluginReloadContinuations([run], context(), () => {}, {
      pluginIds: ["proof"],
    });
    expect(accepted.continuations).toEqual([]);
    expect(h.captureQueue).not.toHaveBeenCalled();
  });
  it("durably cancels an intent after its old source is released, so recovery cannot resurrect it", async () => {
    const ctx = context();
    await preparePluginReloadContinuations([], ctx, () => {}, {
      id: "registration",
      pluginIds: ["proof"],
    });
    h.operations.set("reload-1", operation());
    let finish!: () => void;
    h.saveGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let acknowledged = false;
    const stop = invalidateSessionRunStopIntents({
      source: "client-run",
      sessions: [{ agentId: "main", sessionKey: "agent:main:chat" }],
      runIds: ["old-run"],
    }).then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    finish();
    await stop;
    expect(h.operations.get("reload-1")?.continuations[0]?.state).toBe("cancelled");
    await resumePluginReloadContinuations(operation(), ctx, { status: "committed" });
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

function recoveryFixture() {
  const settled = createDeferredCore<SessionEventOutcome>();
  const released = createDeferredCore();
  const release = vi.fn(() => released.resolve());
  const authority = { assertCurrent: vi.fn(), signal: new AbortController().signal };
  h.loaded.mockResolvedValue({
    storePath: "/synthetic/store",
    entry: { sessionId: "session-1", lifecycleRevision: "revision" },
  });
  h.pendingRead.mockResolvedValue({ kind: "stage" });
  h.captureTarget.mockResolvedValue({ sessionId: "session-1", lifecycleRevision: "revision" });
  h.restore.mockResolvedValue({ authority, release });
  h.enqueue.mockImplementation(
    (_message: string, options: { onAdopted?: () => Promise<void> }) => ({
      id: "wake",
      cancel: vi.fn(() => true),
      accepted: (async () => {
        await options.onAdopted?.();
        return { ok: true };
      })(),
      settled: settled.promise,
    }),
  );
  return { ctx: context(), settled, released, release, authority };
}

it.each(["pending", "accepted"] as const)(
  "hands %s wake custody to durable input admission without waiting for its model task",
  async (state) => {
    const fixture = recoveryFixture();
    const saved = operation();
    saved.state = "succeeded";
    saved.continuations[0]!.state = state;
    h.operations.set(saved.id, saved);
    await resumePluginReloadContinuations(saved, fixture.ctx, { status: "committed" });
    expect(fixture.ctx.logGateway.warn).not.toHaveBeenCalled();
    expect(h.operations.get(saved.id)?.continuations[0]?.state).toBe("accepted");
    expect(fixture.release).not.toHaveBeenCalled();
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.stringContaining("finished with status succeeded"),
      expect.objectContaining({
        sourceTurnId: pluginReloadContinuationSourceId(saved.id, saved.continuations[0]!),
      }),
    );
    await resumePluginReloadContinuations(saved, fixture.ctx, { status: "committed" });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    fixture.settled.resolve({ status: "completed", executionStarted: true, delivered: true });
    await fixture.released.promise;
    expect(h.operations.get(saved.id)?.continuations[0]?.state).toBe("complete");
    expect(fixture.release).toHaveBeenCalledTimes(1);
  },
);

it("restores FIFO queue custody but does not wake a source whose durable reply completed", async () => {
  const fixture = recoveryFixture();
  h.pendingRead.mockResolvedValue({
    kind: "stage",
    previous: { outcome: { reason: "completed", status: "ok" } },
  });
  const saved = operation();
  h.operations.set(saved.id, saved);
  await resumePluginReloadContinuations(saved, fixture.ctx, { status: "recovered", healthy: true });
  expect(fixture.ctx.logGateway.warn).not.toHaveBeenCalled();
  expect(h.continueQueue).toHaveBeenCalledWith(
    fixture.ctx,
    expect.objectContaining({ sessionId: "session-1" }),
    expect.objectContaining({ queuedInputIds: ["q1"] }),
  );
  expect(h.enqueue).not.toHaveBeenCalled();
  expect(h.operations.get(saved.id)?.continuations[0]?.state).toBe("complete");
  expect(fixture.release).toHaveBeenCalledTimes(1);
});

it("rechecks destination authority after awaited row loading before admitting any continuation", async () => {
  const fixture = recoveryFixture();
  h.loaded.mockImplementation(async () => {
    fixture.authority.assertCurrent.mockImplementation(() => {
      throw new Error("authority revoked");
    });
    return {
      storePath: "/synthetic/store",
      entry: { sessionId: "session-1", lifecycleRevision: "revision" },
    };
  });
  const saved = operation();
  h.operations.set(saved.id, saved);
  await resumePluginReloadContinuations(saved, fixture.ctx, { status: "committed" });
  expect(h.enqueue).not.toHaveBeenCalled();
  expect(h.continueQueue).not.toHaveBeenCalled();
  expect(h.operations.get(saved.id)?.continuations[0]?.state).toBe("cancelled");
});

it("consumes queue custody transferred while deferred session recovery was awaited", async () => {
  const fixture = recoveryFixture();
  const saved = operation();
  saved.state = "succeeded";
  h.operations.set(saved.id, saved);
  h.loaded.mockImplementation(async () => {
    const current = h.operations.get(saved.id);
    const continuation = current?.continuations[0];
    if (!continuation) {
      throw new Error("missing continuation fixture");
    }
    continuation.queuedInputIds.push("late-transferred");
    return {
      storePath: "/synthetic/store",
      entry: { sessionId: "session-1", lifecycleRevision: "revision" },
    };
  });
  await resumePluginReloadContinuations(saved, fixture.ctx, { status: "committed" });
  expect(h.continueQueue).toHaveBeenCalledWith(
    fixture.ctx,
    expect.anything(),
    expect.objectContaining({ queuedInputIds: ["q1", "late-transferred"] }),
  );
  fixture.settled.resolve({
    status: "completed",
    executionStarted: true,
    delivered: true,
    conversationResultCommitted: true,
  });
  await fixture.released.promise;
});
