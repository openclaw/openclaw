import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
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
        // The real worker is waiting at COMMIT. Retire the source before the
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

const reach = (gate: Promise<void>, operation: Promise<unknown>) =>
  awaitGateBeforeSettlement(gate, operation, "Attachment fixture settled before its gate");
const captureRejection = (operation: Promise<unknown>) =>
  operation.catch((error: unknown) => error);

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
  expect(snapshot(environmentId)).toEqual(previous);
  await support.reopenWorkerEnvironmentStore();
  expect(snapshot(environmentId)).toEqual(previous);
}

function snapshot(environmentId: string) {
  return {
    environment: support.testState.store.get(environmentId),
    credential: support.testState.store.getCredential(environmentId),
  };
}

async function attachmentFixture(environmentId: string) {
  await support.seedReady(environmentId);
  const previous = snapshot(environmentId);
  const source = caller(environmentId);
  const generate = vi.fn(() => support.CREDENTIAL);
  const service = support.createService(support.createProvider(), {
    generateWorkerCredential: generate,
  });
  return { source, generate, service, previous };
}

describe("attachment precommit authority and committed custody", () => {
  support.setupWorkerEnvironmentServiceSuite();
  afterEach(() => {
    nativeAdmission.before = undefined;
  });

  it.each(["queue", "caller", "service", "commit"] as const)(
    "preserves durable attachment state after authority closes at %s",
    async (phase) => {
      const environmentId = `attachment-${phase}`;
      const { previous, source, generate, service } = await attachmentFixture(environmentId);
      const mintedWhileLive: boolean[] = [];
      const gate =
        phase === "commit"
          ? undefined
          : bundleGate(phase === "queue" ? new Error("predecessor build unavailable") : undefined);
      let predecessor: Promise<unknown> | undefined;
      if (phase === "queue") {
        // The predecessor owns the queue and fails packaging without changing ownership.
        predecessor = captureRejection(
          service.attachSession({ environmentId, ownerEpoch: 1, sessionId: "predecessor" }),
        );
        await reach(gate!.entered.promise, predecessor);
      } else if (phase === "commit") {
        generate.mockImplementation(() => {
          mintedWhileLive.push(source.isCurrent());
          return support.CREDENTIAL;
        });
        // Exclude startup recovery from the native admission interception.
        await service.ready();
        nativeAdmission.before = (stage) => {
          if (stage === "commit") {
            nativeAdmission.before = undefined;
            source.close();
          }
        };
      }
      const attaching = captureRejection(service.attachSession(binding(environmentId, source)));
      let stopping: Promise<void> | undefined;
      try {
        if (phase === "caller" || phase === "service") {
          await reach(gate!.entered.promise, attaching);
        }
        if (phase === "service") {
          stopping = service.stop();
        } else if (phase !== "commit") {
          source.close();
        }
      } finally {
        gate?.release.resolve();
        await predecessor;
        await attaching;
        await stopping;
      }
      expect(source.signal.aborted).toBe(false);
      if (predecessor) {
        expect(await predecessor).toMatchObject({
          message: "Current worker build identity is unavailable",
        });
      }
      expect(await attaching).toMatchObject({
        message:
          phase === "service"
            ? "Worker environment service is stopping"
            : "Attachment caller closed",
      });
      if (phase === "commit") {
        // Minting precedes the native wait; revocation must prevent persistence.
        expect(mintedWhileLive).toEqual([true]);
      } else {
        expect(generate).not.toHaveBeenCalled();
      }
      await expectUnchangedAfterReopen(environmentId, previous);
    },
  );

  it("does not lend one queued request another caller's authority", async () => {
    const environmentId = "attachment-independent-callers";
    const { source: first, generate, service } = await attachmentFixture(environmentId);
    const second = caller(`${environmentId}:second`);
    const gate = bundleGate();
    const original = captureRejection(service.attachSession(binding(environmentId, first)));
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
    const harness = await createHarness(support.testState.stateDb, placements);
    await support.seedReady(harness.ready.environmentId);
    vi.mocked(harness.environments.attachSession).mockImplementation(service.attachSession);
    const gate = bundleGate();
    const dispatching = captureRejection(
      harness.service.dispatch(REQUEST, undefined, source.assertCurrent, source.signal),
    );
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
    const command = captureRejection(handle.runWorkspaceCommand(PWD_COMMAND));
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
