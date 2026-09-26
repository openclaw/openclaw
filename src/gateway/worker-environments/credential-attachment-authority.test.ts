import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { SqliteWorkerAdmissionRequest } from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import { fakeRunner, PWD_COMMAND, startTestTunnel, success } from "./tunnel.test-support.js";

const nativeAdmission = vi.hoisted(() => ({
  before: undefined as ((stage: SqliteWorkerAdmissionRequest["stage"]) => void) | undefined,
}));
vi.mock("../../infra/sqlite-worker-operation-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/sqlite-worker-operation-admission.js")>();
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (
      admit: Parameters<typeof actual.createSqliteWorkerOperationAdmission>[0],
      attachment?: Parameters<typeof actual.createSqliteWorkerOperationAdmission>[1],
    ) =>
      actual.createSqliteWorkerOperationAdmission((request, grant) => {
        // The real worker is waiting at BEGIN/COMMIT. Retire the source before the
        // existing synchronous host decision; do not replace the store or grant.
        nativeAdmission.before?.(request.stage);
        admit(request, grant);
      }, attachment),
  };
});

function caller(id: string) {
  const controller = new AbortController();
  const authority = claimAgentRunDelegatedAuthority({ instanceId: id, runId: id });
  const close = () => {
    releaseAgentRunDelegatedAuthority(authority);
  };
  support.testState.releaseTurnOwners.push(close);
  return {
    signal: controller.signal,
    close,
    isCurrent: () => validateAgentRunDelegatedAuthority(authority),
    assertCurrent: () => {
      controller.signal.throwIfAborted();
      if (!validateAgentRunDelegatedAuthority(authority)) {
        throw new Error("Attachment caller closed");
      }
    },
  };
}

function bundleGate(error?: Error) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  vi.mocked(support.testState.prepareInstallation).mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    if (error) {
      throw error;
    }
    return support.BUNDLE_ARTIFACT;
  });
  return { entered, release };
}

async function reach(gate: Promise<void>, operation: Promise<unknown>) {
  await Promise.race([
    gate,
    operation.then(() => {
      throw new Error("Attachment fixture settled before its gate");
    }),
  ]);
}

function binding(environmentId: string, source: ReturnType<typeof caller>) {
  return {
    environmentId,
    ownerEpoch: 1,
    sessionId: `session:${environmentId}`,
    assertCurrent: source.assertCurrent,
  };
}

async function expectUnchangedAfterReopen(
  environmentId: string,
  previous: ReturnType<typeof snapshot>,
) {
  expect(support.testState.store.get(environmentId)).toEqual(previous.environment);
  expect(support.testState.store.getCredential(environmentId)).toEqual(previous.credential);
  await support.reopenWorkerEnvironmentStore();
  expect(support.testState.store.get(environmentId)).toEqual(previous.environment);
  expect(support.testState.store.getCredential(environmentId)).toEqual(previous.credential);
}

function snapshot(environmentId: string) {
  return {
    environment: support.testState.store.get(environmentId),
    credential: support.testState.store.getCredential(environmentId),
  };
}

describe("attachment precommit authority and committed custody", () => {
  support.setupWorkerEnvironmentServiceSuite({ reuseReadWorkers: true });
  afterEach(() => {
    nativeAdmission.before = undefined;
  });

  it("rejects a closed caller after the real per-environment queue wait", async () => {
    const environmentId = "attachment-queue";
    await support.seedReady(environmentId);
    const previous = snapshot(environmentId);
    const source = caller(environmentId);
    const generate = vi.fn(() => support.CREDENTIAL);
    const service = support.createService(support.createProvider(), {
      generateWorkerCredential: generate,
    });
    // This earlier request owns the queue, not the later caller. Its failed
    // packaging releases the queue without changing attachment ownership.
    const gate = bundleGate(new Error("predecessor build unavailable"));
    const predecessor = service
      .attachSession({ environmentId, ownerEpoch: 1, sessionId: "predecessor" })
      .catch((error: unknown) => error);
    await reach(gate.entered.promise, predecessor);
    const attaching = service
      .attachSession(binding(environmentId, source))
      .catch((error: unknown) => error);
    try {
      source.close();
      expect(source.signal.aborted).toBe(false);
    } finally {
      gate.release.resolve();
      await predecessor;
      await attaching;
    }
    expect(await predecessor).toMatchObject({
      message: "Current worker build identity is unavailable",
    });
    expect(await attaching).toMatchObject({ message: "Attachment caller closed" });
    expect(support.testState.prepareInstallation).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    await expectUnchangedAfterReopen(environmentId, previous);
  });

  it.each(["caller", "service"] as const)(
    "does not mint after %s closure during packaging",
    async (closedOwner) => {
      const environmentId = `attachment-bundle-${closedOwner}`;
      await support.seedReady(environmentId);
      const previous = snapshot(environmentId);
      const source = caller(environmentId);
      const generate = vi.fn(() => support.CREDENTIAL);
      const service = support.createService(support.createProvider(), {
        generateWorkerCredential: generate,
      });
      const gate = bundleGate();
      const attaching = service
        .attachSession(binding(environmentId, source))
        .catch((error: unknown) => error);
      let stopping: Promise<void> | undefined;
      try {
        await reach(gate.entered.promise, attaching);
        if (closedOwner === "caller") {
          source.close();
        } else {
          stopping = service.stop();
        }
        expect(source.signal.aborted).toBe(false);
      } finally {
        gate.release.resolve();
        await attaching;
        await stopping;
      }
      expect(await attaching).toMatchObject({
        message:
          closedOwner === "caller"
            ? "Attachment caller closed"
            : "Worker environment service is stopping",
      });
      expect(generate).not.toHaveBeenCalled();
      await expectUnchangedAfterReopen(environmentId, previous);
    },
  );

  it.each(["transaction", "commit"] as const)(
    "refuses closed source at actual native %s admission",
    async (stage) => {
      const environmentId = `attachment-native-${stage}`;
      await support.seedReady(environmentId);
      const previous = snapshot(environmentId);
      const source = caller(environmentId);
      const mintedWhileLive: boolean[] = [];
      const service = support.createService(support.createProvider(), {
        generateWorkerCredential: () => {
          mintedWhileLive.push(source.isCurrent());
          return support.CREDENTIAL;
        },
      });
      // Startup inference recovery uses the same native admission factory.
      await service.ready();
      const reached: string[] = [];
      nativeAdmission.before = (current) => {
        reached.push(current);
        if (current === stage) {
          nativeAdmission.before = undefined;
          source.close();
        }
      };
      const outcome = await service
        .attachSession(binding(environmentId, source))
        .catch((error: unknown) => error);
      expect(reached).toContain(stage);
      expect(outcome).toMatchObject({ message: "Attachment caller closed" });
      expect(source.signal.aborted).toBe(false);
      // Material was prepared before the native wait, while the source was live.
      // Revocation must prevent persistence, not pretend that prior mint never ran.
      expect(mintedWhileLive).toEqual([true]);
      await expectUnchangedAfterReopen(environmentId, previous);
    },
  );

  it("does not lend one queued request another caller's authority", async () => {
    const environmentId = "attachment-independent-callers";
    await support.seedReady(environmentId);
    const first = caller(`${environmentId}:first`);
    const second = caller(`${environmentId}:second`);
    const generate = vi.fn(() => support.CREDENTIAL);
    const service = support.createService(support.createProvider(), {
      generateWorkerCredential: generate,
    });
    const gate = bundleGate();
    const original = service
      .attachSession(binding(environmentId, first))
      .catch((error: unknown) => error);
    let successor: ReturnType<typeof service.attachSession> | undefined;
    try {
      await reach(gate.entered.promise, original);
      successor = service.attachSession({
        ...binding(environmentId, second),
        sessionId: "second-session",
      });
      void successor.catch(() => undefined);
      first.close();
    } finally {
      gate.release.resolve();
      await original;
      await successor?.catch(() => undefined);
    }
    expect(await original).toMatchObject({ message: "Attachment caller closed" });
    const grant = await successor;
    expect(grant).toMatchObject({ sessionId: "second-session", ownerEpoch: 2 });
    expect(generate).toHaveBeenCalledOnce();
    expect(first.signal.aborted).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "attached",
      attachedSessionIds: ["second-session"],
      ownerEpoch: 2,
    });
  });

  it("carries the cold dispatch caller through the real service and broker", async () => {
    const source = caller("cold-dispatch-attachment");
    const generate = vi.fn(() => support.CREDENTIAL);
    const service = support.createService(support.createProvider(), {
      generateWorkerCredential: generate,
    });
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const harness = createHarness(support.testState.stateDb, placements);
    await support.seedReady(harness.ready.environmentId);
    vi.mocked(harness.environments.attachSession).mockImplementation(service.attachSession);
    const gate = bundleGate();
    const dispatching = harness.service
      .dispatch(REQUEST, undefined, source.assertCurrent, source.signal)
      .catch((error: unknown) => error);
    try {
      await reach(gate.entered.promise, dispatching);
      source.close();
    } finally {
      gate.release.resolve();
      await dispatching;
    }
    expect(await dispatching).toMatchObject({ message: "Attachment caller closed" });
    expect(source.signal.aborted).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
  });

  it("joins exact tunnel cleanup and returns committed attachment after caller closure", async () => {
    const environmentId = "attachment-committed-custody";
    await support.seedReady(environmentId);
    const source = caller(environmentId);
    const commandEntered = createDeferredCore();
    const cleanupEntered = createDeferredCore();
    const childClosed = createDeferredCore<ReturnType<typeof success>>();
    const fake = fakeRunner(async (_argv, options) => {
      options.signal?.addEventListener("abort", () => cleanupEntered.resolve(), { once: true });
      commandEntered.resolve();
      return await childClosed.promise;
    });
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const stop = vi.spyOn(manager, "stop");
    const service = support.createService(support.createProvider(), { tunnelManager: manager });
    const handle = await startTestTunnel(manager, environmentId, 1);
    const command = handle.runWorkspaceCommand(PWD_COMMAND).catch((error: unknown) => error);
    await reach(commandEntered.promise, command);
    const settled = vi.fn();
    const attaching = service.attachSession(binding(environmentId, source)).finally(settled);
    void attaching.catch(() => undefined);
    let committed: ReturnType<typeof snapshot> | undefined;
    try {
      await reach(cleanupEntered.promise, attaching);
      committed = snapshot(environmentId);
      expect(committed.environment).toMatchObject({ state: "attached", ownerEpoch: 2 });
      source.close();
      expect(source.signal.aborted).toBe(false);
      expect(settled).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledExactlyOnceWith(environmentId, 1);
    } finally {
      childClosed.resolve({
        ...success(),
        code: null,
        signal: "SIGTERM",
        killed: true,
        termination: "signal",
      });
      await command;
      await attaching;
      await manager.stopAll();
    }
    const grant = await attaching;
    expect(grant).toMatchObject({ ownerEpoch: 2, sessionId: `session:${environmentId}` });
    expect(service.takeMintedCredential(grant)).toEqual(grant);
    expect(grant.deliveryId).toBe(committed?.credential?.credentialHash);
    expect(manager.status(environmentId)).toBe("stopped");
    await expectUnchangedAfterReopen(environmentId, committed!);
  });
});
