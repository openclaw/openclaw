import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STALE_WORKER_BUILD_REASON } from "./admission.js";
import { createStoppedTunnelManager } from "./environment-access.test-support.js";
import * as support from "./service.test-support.js";
import { testState } from "./service.test-support.js";

const environmentId = "worker";
let credentialSequence = 0;
const createService = (options?: Parameters<typeof support.createService>[1]) =>
  support.createService(support.createProvider(), {
    generateWorkerCredential: () => `${support.CREDENTIAL}-${++credentialSequence}`,
    ...options,
  });
const attach = (service: ReturnType<typeof createService>, sessionId: string, id = environmentId) =>
  service.attachSession({ environmentId: id, ownerEpoch: 1, sessionId });

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();
  beforeEach(() => {
    credentialSequence = 0;
  });

  it("repairs duplicate session owners", async () => {
    const sessionId = "legacy";
    const older = await support.seedAttachedIdentity("legacy-a", sessionId);
    const newer = await support.seedAttachedIdentity("legacy-b", "other");
    support.testState.stateDb.db.exec(`
      UPDATE worker_environments SET attached_session_ids_json = '["legacy"]'
        WHERE environment_id = 'legacy-b';
      UPDATE worker_environment_credentials SET session_id = 'legacy'
        WHERE environment_id = 'legacy-b';
    `);

    await support.reopenWorkerEnvironmentStore();
    const liveEvents = support.createLiveEvents();
    const { identity, workerService: service } = await support.bindPlacementHarness(
      {
        ...newer,
        sessionId,
        turnClaim: {
          ...expectDefined(newer.turnClaim, "surviving worker fixture turn claim"),
          sessionId,
        },
      },
      { liveEvents },
    );
    const event = { ...support.LIVE_EVENT, runEpoch: newer.ownerEpoch };
    await expect(service.pushLiveEvent(older, event)).resolves.toEqual({
      ok: false,
      closeReason: "credential-replaced",
    });
    await expect(service.pushLiveEvent(identity, event)).resolves.toMatchObject({ ok: true });
    expect(liveEvents.apply).toHaveBeenCalledOnce();
  });

  it("rejects attach before current bootstrap", async () => {
    const bootstrapping = await support.seedBootstrapping(environmentId);
    await support.testState.store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: support.readyPatch(environmentId, {
        ...support.BOOTSTRAP_RECEIPT,
        bundleHash: "c".repeat(64),
      }),
    });
    await expect(attach(createService(), "session-1")).rejects.toThrow(STALE_WORKER_BUILD_REASON);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "ready",
      attachedSessionIds: [],
    });
  });

  it("returns a bounded error when another worker owns the session", async () => {
    await support.seedReady(environmentId);
    await support.seedReady("contender");
    const service = createService();

    await attach(service, "session-owned");
    await expect(attach(service, "session-owned", "contender")).rejects.toMatchObject({
      code: "invalid_state",
      message: `Session session-owned is already attached to worker environment ${environmentId}`,
    });
    expect(support.testState.store.get("contender")).toMatchObject({
      state: "ready",
      attachedSessionIds: [],
    });
  });

  it("requires session reclaim before operator destruction of an attached worker", async () => {
    await support.seedReady(environmentId);
    const service = createService();
    await attach(service, "session-reclaim");

    await expect(service.destroyUnattached(environmentId)).rejects.toMatchObject({
      code: "invalid_state",
      message: "Attached cloud workers must be stopped through sessions.reclaim",
    });
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "attached",
      attachedSessionIds: ["session-reclaim"],
    });
  });

  it("renews in place and binds delivery acknowledgement to the exact grant", async () => {
    await support.seedReady(environmentId);
    const service = createService({ workerCredentialTtlMs: 100 });

    const binding = { environmentId, ownerEpoch: 1, sessionId: null };
    await service.reconcileOnce();
    const previous = service.takeMintedCredential(binding)!;
    support.testState.nowMs += 100;
    expect(service.takeMintedCredential(binding)).toBeUndefined();
    await service.reconcileOnce();
    const renewal = service.takeMintedCredential(binding)!;
    expect(renewal).toMatchObject({ ownerEpoch: 1, sessionId: null });
    expect(support.testState.store.get(environmentId)?.ownerEpoch).toBe(1);
    expect(await service.acknowledgeCredentialDelivery(previous)).toBe(false);
    expect(service.takeMintedCredential(binding)).toMatchObject({ deliveryId: renewal.deliveryId });
    expect(await service.acknowledgeCredentialDelivery(renewal)).toBe(true);
  });

  it("recovers an undelivered atomic session credential after restart without changing owner", async () => {
    await support.seedReady(environmentId);
    const stopTunnel = vi.fn(async () => {
      throw new Error("tunnel stop interrupted");
    });
    const tunnelManager = createStoppedTunnelManager();
    tunnelManager.stop = stopTunnel;
    const first = createService({ tunnelManager });
    await first.reconcileOnce();
    await expect(attach(first, "session-1")).rejects.toThrow("tunnel stop interrupted");
    const binding = { environmentId, ownerEpoch: 2, sessionId: "session-1" };
    const lostHash = support.testState.store.getCredential(environmentId)?.credentialHash;

    expect(stopTunnel).toHaveBeenCalledWith(environmentId, 1);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "attached",
      ownerEpoch: 2,
    });
    expect(first.takeMintedCredential(binding)).toBeUndefined();

    await support.reopenWorkerEnvironmentStore();
    const restarted = createService({ tunnelManager });
    await restarted.reconcileOnce();

    const recovered = restarted.takeMintedCredential(binding);
    expect(recovered?.deliveryId).not.toBe(lostHash);
    expect(await restarted.acknowledgeCredentialDelivery(recovered!)).toBe(true);
    const deliveredHash = support.testState.store.getCredential(environmentId)?.credentialHash;

    await support.reopenWorkerEnvironmentStore();
    const deliveredRestart = createService({ tunnelManager });
    await deliveredRestart.reconcileOnce();
    expect(deliveredRestart.takeMintedCredential(binding)).toBeUndefined();
    expect(testState.store.getCredential(environmentId)?.credentialHash).toBe(deliveredHash);
  });
});
