import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionCatalogListProviderParams } from "../../plugins/session-catalog.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  getGatewayRestartDrainSignal,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { GatewayConnectionWork } from "../server-connection-work.js";
import { catalogLog } from "./session-catalog-log.test-support.js";

const { SessionCatalogListLifetime } = await import("./session-catalog-list-lifetime.js");

const host: SessionCatalogHost = {
  hostId: "node:late",
  kind: "node",
  label: "Late host",
  connected: true,
  sessions: [],
};
const catalog = {
  id: "fixture",
  label: "Fixture",
  capabilities: { continueSession: false, archive: false },
  hosts: [host],
};

const ignore = () => undefined;
const current = () => true;
function admit(origin: string, signals: AbortSignal[] = []) {
  const before = getActiveGatewayRootWorkHolders();
  const root = tryBeginGatewayRootWorkAdmission(origin);
  expect(root).not.toBeNull();
  const lifetime = new SessionCatalogListLifetime(signals);
  const run: typeof lifetime.runProvider = (publish, provider) =>
    root!.run(() => lifetime.runProvider(publish, provider));
  return {
    before,
    root: root!,
    lifetime,
    run,
    release: createDeferredCore(),
    finish: () => {
      lifetime.finishListing();
      root!.release();
    },
  };
}

function preparationGate() {
  const release = createDeferredCore();
  let ready = false;
  const preparation = release.promise.then(() => {
    ready = true;
  });
  return { release, prepare: vi.fn(() => (ready ? undefined : preparation)) };
}

describe("catalog list completion ownership", () => {
  it.each([
    { stage: "preparation", retirement: "none" },
    { stage: "publication", retirement: "none" },
    { stage: "preparation", retirement: "lifetime" },
    { stage: "preparation", retirement: "subscriber" },
  ])(
    "reports late $stage failure without losing settlement (retirement=$retirement)",
    async ({ stage, retirement }) => {
      const { before, root, lifetime, finish } = admit("catalog-late-delivery-failure");
      const owner = new GatewayConnectionWork();
      const preparation = createDeferredCore();
      const failure = new Error("private fixture session details");
      let subscriberCurrent = true;
      const delivered = vi.fn(() => {
        if (stage === "publication") {
          throw failure;
        }
      });
      catalogLog.warn.mockClear();
      try {
        await owner.track(() =>
          root.run(async () => {
            lifetime.subscribe(
              "active",
              delivered,
              () => subscriberCurrent,
              undefined,
              () => preparation.promise,
            );
            await lifetime.runProvider(
              () => lifetime.publish(catalog, new Map()),
              async (params) => params.onHost(host),
            );
          }),
        );
        finish();
        expect(getActiveGatewayRootWorkCount()).toBe(before.length + 1);
        if (retirement === "lifetime") {
          lifetime.retire();
        } else if (retirement === "subscriber") {
          subscriberCurrent = false;
        }
        if (stage === "preparation") {
          preparation.reject(failure);
        } else {
          preparation.resolve();
        }
        await owner.drain();
        expect(delivered).toHaveBeenCalledTimes(stage === "publication" ? 1 : 0);
        expect(catalogLog.warn.mock.calls).toEqual(
          retirement !== "none"
            ? []
            : [["Session catalog progress update failed; refresh the catalog to retry."]],
        );
        expect(getActiveGatewayRootWorkHolders()).toEqual(before);
      } finally {
        preparation.resolve();
        finish();
        await owner.drain();
      }
    },
  );

  it.each([false, true])(
    "owns deferred subscriber delivery and rechecks retirement (retired=%s)",
    async (retired) => {
      const { before, root, lifetime, finish } = admit("catalog-deferred-subscriber");
      const owner = new GatewayConnectionWork();
      const delivered = vi.fn();
      const { release, prepare } = preparationGate();
      let drained = false;
      try {
        await owner.track(() =>
          root!.run(async () => {
            lifetime.subscribe("active", delivered, current, undefined, prepare);
            await lifetime.runProvider(
              () => lifetime.publish(catalog, new Map()),
              async (params) => params.onHost(host),
            );
          }),
        );
        root!.release();
        lifetime.finishListing();
        const closing = owner.drain().then(() => {
          drained = true;
        });
        await nextTurn();
        expect(drained).toBe(false);
        expect(getActiveGatewayRootWorkCount()).toBe(before.length + 1);
        if (retired) {
          lifetime.retire();
        }
        release.resolve();
        await closing;
        expect(delivered).toHaveBeenCalledTimes(retired ? 0 : 1);
        expect(getActiveGatewayRootWorkCount()).toBe(before.length);
      } finally {
        release.resolve();
        finish();
        await owner.drain();
      }
    },
  );

  it("retains each catalog host's latest late publication while subscriber preparation waits", async () => {
    const catalogIds = ["alpha", "beta"];
    const hostIds = ["node:first", "node:second"];
    const lifetime = new SessionCatalogListLifetime([]);
    const owner = new GatewayConnectionWork();
    const publish = createDeferredCore();
    const { release, prepare } = preparationGate();
    const publications: Promise<void>[] = [];
    const delivered = vi.fn();
    try {
      await owner.track(async () => {
        lifetime.subscribe("active", delivered, () => true, undefined, prepare);
        await Promise.all(
          catalogIds.map((id) =>
            lifetime.runProvider(
              (updated) =>
                lifetime.publish(
                  { ...catalog, id, label: updated.label, hosts: [updated] },
                  new Map(),
                ),
              async (params) => {
                const publication = publish.promise.then(() => {
                  for (let index = 0; index < 100; index++) {
                    for (const hostId of hostIds) {
                      params.onHost({ ...host, hostId, label: `${id}/${hostId} ${index}` });
                    }
                  }
                });
                publications.push(publication);
                params.waitUntil(publication);
              },
            ),
          ),
        );
      });
      lifetime.finishListing();
      publish.resolve();
      await Promise.all(publications);
      expect(delivered).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledOnce();
      release.resolve();
      await owner.drain();
      expect(delivered.mock.calls).toEqual(
        catalogIds.flatMap((id) =>
          hostIds.map((hostId) => [
            {
              ...catalog,
              id,
              label: `${id}/${hostId} 99`,
              hosts: [{ ...host, hostId, label: `${id}/${hostId} 99` }],
            },
            new Map(),
          ]),
        ),
      );
    } finally {
      publish.resolve();
      release.resolve();
      await Promise.allSettled(publications);
      await owner.drain();
      lifetime.retire();
      lifetime.finishListing();
    }
  });

  it("keeps work started before retirement owned when registration follows an await", async () => {
    const {
      before,
      root,
      lifetime,
      run,
      release: releaseWork,
      finish,
    } = admit("catalog-register-after-retirement");
    const releaseListing = createDeferredCore();
    const publish = vi.fn();
    let publication: Promise<void> | undefined;
    let signal: AbortSignal | undefined;
    const listing = run(publish, async (params) => {
      signal = params.signal;
      publication = releaseWork.promise.then(() => params.onHost(host));
      await releaseListing.promise;
      params.waitUntil(publication);
    });
    try {
      lifetime.retire();
      releaseListing.resolve();
      await expect(listing).resolves.toBeUndefined();
      root!.release();
      lifetime.finishListing();
      expect(signal?.aborted).toBe(true);
      expect(getActiveGatewayRootWorkCount()).toBe(before.length + 1);
      releaseWork.resolve();
      await publication;
      expect(publish).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(before.length);
    } finally {
      releaseListing.resolve();
      releaseWork.resolve();
      await Promise.allSettled([listing, publication]);
      finish();
    }
  });

  it.each([
    { background: false, throws: false },
    { background: false, throws: true },
    { background: true, throws: false },
    { background: true, throws: true },
  ])(
    "closes callbacks and retains roots through publication (background=$background, throws=$throws)",
    async ({ background, throws }) => {
      const { before, root, lifetime, run, release, finish } = admit("catalog-callback-ownership");
      lifetime.subscribe("active", ignore, current);
      let publication: Promise<void> | undefined;
      let retained: SessionCatalogListProviderParams | undefined;
      const publish = vi.fn(() => {
        expect(getActiveGatewayRootWorkCount()).toBe(before.length + 1);
        if (background && throws) {
          throw new Error("publication failed");
        }
      });
      try {
        const listing = run(publish, async (params) => {
          retained = params;
          if (background) {
            publication = release.promise.then(() => params.onHost(host));
            params.waitUntil(publication);
          } else {
            params.onHost(host);
            if (throws) {
              throw new Error("catalog list failed");
            }
          }
          return [];
        });
        if (!background && throws) {
          await expect(listing).rejects.toThrow("catalog list failed");
        } else {
          await expect(listing).resolves.toEqual([]);
        }
        root!.release();
        lifetime.finishListing();
        expect(() => retained?.waitUntil?.(Promise.resolve())).toThrow(/registration is closed/);
        expect(retained?.signal?.aborted).toBe(!background);
        if (background) {
          expect(getActiveGatewayRootWorkCount()).toBe(before.length + 1);
          release.resolve();
          await publication?.catch(() => undefined);
        }
        expect(publish).toHaveBeenCalledOnce();
        expect(getActiveGatewayRootWorkHolders()).toEqual(before);
        retained?.onHost?.(host);
        expect(publish).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await publication?.catch(() => undefined);
        finish();
      }
    },
  );

  it("keeps completion on its admitted owner when an external callback registers it", async () => {
    const before = getActiveGatewayRootWorkHolders();
    const ownerOrigin = "catalog-original-owner";
    const foreignOrigin = "catalog-foreign-callback";
    const root = tryBeginGatewayRootWorkAdmission(ownerOrigin);
    const foreignRoot = tryBeginGatewayRootWorkAdmission(foreignOrigin);
    expect(root).not.toBeNull();
    expect(foreignRoot).not.toBeNull();
    const owner = new GatewayConnectionWork();
    const foreign = new GatewayConnectionWork();
    const lifetime = new SessionCatalogListLifetime([owner.signal]);
    lifetime.subscribe("active", ignore, current);
    const callback = new EventEmitter();
    const registered = createDeferredCore();
    const release = createDeferredCore();
    const publish = vi.fn();
    let publication: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let ownerDrained = false;
    let foreignDrained = false;
    let rootsAtOwnerDrain: string[] | undefined;
    const listing = owner.track(() =>
      root!.run(() =>
        lifetime.runProvider(publish, async (params) => {
          publication = release.promise.then(() => params.onHost(host));
          // EventEmitter invokes the callback in the emitter's current context.
          callback.once("register", () => {
            params.waitUntil(publication!);
            registered.resolve();
          });
          await registered.promise;
        }),
      ),
    );
    try {
      await foreign.track(() => foreignRoot!.run(async () => callback.emit("register")));
      foreignRoot!.release();
      await listing;
      root!.release();
      lifetime.finishListing();
      const retained = getActiveGatewayRootWorkHolders();
      closing = Promise.all([
        owner.drain().then(() => {
          rootsAtOwnerDrain = getActiveGatewayRootWorkHolders();
          ownerDrained = true;
        }),
        foreign.drain().then(() => {
          foreignDrained = true;
        }),
      ]).then(() => undefined);
      await nextTurn();
      const whileHeld = { ownerDrained, foreignDrained };
      release.resolve();
      await publication;
      await closing;
      expect(whileHeld).toEqual({ ownerDrained: false, foreignDrained: true });
      expect(retained).toEqual([...before, ownerOrigin].toSorted((a, b) => a.localeCompare(b)));
      expect(rootsAtOwnerDrain).toEqual(before);
      expect(getActiveGatewayRootWorkHolders()).toEqual(before);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      registered.resolve();
      release.resolve();
      await Promise.allSettled([listing, publication, closing]);
      lifetime.finishListing();
      root!.release();
      foreignRoot!.release();
      callback.removeAllListeners();
      await Promise.all([owner.drain(), foreign.drain()]);
    }
  });

  it.each([false, true])(
    "disconnects a subscriber without cancelling native completion (last=%s)",
    async (last) => {
      const { before, root, lifetime, run, release, finish } = admit(
        "catalog-subscriber-disconnect",
      );
      const connection = new AbortController();
      const disconnected = vi.fn();
      const live = vi.fn();
      lifetime.subscribe("old", disconnected, () => true, connection.signal);
      if (!last) {
        lifetime.subscribe("live", live, () => true);
      }
      const publish = vi.fn(() => lifetime.publish(catalog, new Map()));
      let publication: Promise<void> | undefined;
      let signal: AbortSignal | undefined;
      try {
        await run(publish, async (params) => {
          signal = params.signal;
          publication = release.promise.then(() => params.onHost(host));
          params.waitUntil(publication);
        });
        root!.release();
        lifetime.finishListing();
        connection.abort();
        expect(signal?.aborted).toBe(false);
        expect(getActiveGatewayRootWorkCount()).toBe(before.length + 1);
        release.resolve();
        await publication;
        expect(disconnected).not.toHaveBeenCalled();
        expect(live).toHaveBeenCalledTimes(last ? 0 : 1);
        expect(publish).toHaveBeenCalledTimes(last ? 0 : 1);
        expect(getActiveGatewayRootWorkCount()).toBe(before.length);
      } finally {
        release.resolve();
        await publication;
        finish();
      }
    },
  );

  it.each(["signal", "aggregate-failure", "provider-failure", "gateway-drain"] as const)(
    "retires delivery on %s without declaring an ignoring producer finished",
    async (retirement) => {
      const controller = new AbortController();
      const { before, root, lifetime, run, release, finish } = admit("catalog-retirement-test", [
        retirement === "gateway-drain" ? getGatewayRestartDrainSignal() : controller.signal,
      ]);
      lifetime.subscribe("active", ignore, current);
      const publish = vi.fn();
      let publication: Promise<void> | undefined;
      let signal: AbortSignal | undefined;
      try {
        const listing = run(publish, async (params) => {
          signal = params.signal;
          const completion =
            retirement === "gateway-drain"
              ? new Promise<void>((resolve) => {
                  params.signal.addEventListener("abort", () => resolve(), { once: true });
                })
              : release.promise;
          publication = completion.then(() => params.onHost(host));
          params.waitUntil(publication);
          if (retirement === "provider-failure") {
            throw new Error("provider failed");
          }
        });
        if (retirement === "provider-failure") {
          await expect(listing).rejects.toThrow("provider failed");
        } else {
          await listing;
        }
        root!.release();
        lifetime.finishListing();
        expect(getActiveGatewayRootWorkCount()).toBe(before.length + 1);
        if (retirement === "gateway-drain") {
          markGatewayRestartDraining();
          expect(tryBeginGatewayRootWorkAdmission("after-drain")).toBeNull();
        } else if (retirement === "signal") {
          controller.abort();
        } else if (retirement === "aggregate-failure") {
          lifetime.retire(new Error("response failed"));
        }
        expect(signal?.aborted).toBe(true);
        expect(getActiveGatewayRootWorkCount()).toBe(before.length + 1);
        release.resolve();
        await publication;
        expect(publish).not.toHaveBeenCalled();
        expect(getActiveGatewayRootWorkCount()).toBe(before.length);
      } finally {
        release.resolve();
        lifetime.retire();
        await publication;
        finish();
        if (retirement === "gateway-drain") {
          resetGatewayWorkAdmission();
        }
      }
    },
  );
});
