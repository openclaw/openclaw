import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import {
  getActiveGatewayRootWorkHolders,
  resetGatewayWorkAdmission,
  retainGatewayRootWorkAdmissionContinuation,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
  retainGatewayDeviceRevocation,
} from "../device-revocation.js";
import { SessionCatalogListLifetime } from "./session-catalog-list-lifetime.js";
import { listSessionCatalogProvider } from "./session-catalog-provider-access.js";
import { catalogHost, catalogProvider } from "./session-catalog.fixtures.test-support.js";

const blockedProvider = (gate: ReturnType<typeof createDeferredCore<SessionCatalogHost[]>>) =>
  catalogProvider("blocking-catalog", {
    label: "Blocking catalog",
    list: vi.fn(() => gate.promise),
  });
const occupyProviders = (blocker: SessionCatalogProvider, signal?: AbortSignal) =>
  Array.from({ length: 16 }, (_, index) =>
    listSessionCatalogProvider({ ...blocker, id: `blocking-catalog-${index}` }, { signal }),
  );
const inRegistry = <T>(
  pluginRegistry: ReturnType<typeof createEmptyPluginRegistry>,
  pluginId: string,
  run: () => T,
) =>
  withPluginRuntimeGatewayRequestScope(
    { pluginRegistry, pluginId, isWebchatConnect: () => false },
    run,
  );

describe("session catalog provider admission", () => {
  it.each([false, true])(
    "retains the catalog caller for delayed node discovery without admitting revoked access (%s)",
    async (revoked) => {
      const context = {};
      const connection = new AbortController();
      const sourceReleased = vi.fn();
      const caller = captureGatewayDeviceRevocation(
        context,
        { deviceId: "catalog-device", role: "operator" },
        () => true,
        connection.signal,
        { isCurrent: () => true, subscribe: () => sourceReleased },
      );
      const discovery = createDeferredCore();
      const hosts = [
        catalogHost({ hostId: "node:catalog-device", label: "Test node", kind: "node" }),
      ];
      const provider = catalogProvider("delayed-node-catalog", {
        label: "Delayed node catalog",
        list: async () => {
          await discovery.promise;
          const releaseNode = retainGatewayDeviceRevocation(
            getPluginRuntimeGatewayRequestScope()?.hasCurrentClientAuthority,
          );
          try {
            return hosts;
          } finally {
            releaseNode?.();
          }
        },
      });
      const lifetime = new SessionCatalogListLifetime([]);
      const result = withPluginRuntimeGatewayRequestScope(
        { hasCurrentClientAuthority: caller.isCurrent, isWebchatConnect: () => false },
        () =>
          lifetime.runProvider(undefined, (params) => listSessionCatalogProvider(provider, params)),
      );
      caller.release();
      lifetime.finishListing();
      if (revoked) {
        invalidateGatewayDeviceRevocation(context, "catalog-device", "operator");
      }
      discovery.resolve();
      try {
        if (revoked) {
          await expect(result).rejects.toThrow("Gateway caller authority is no longer active.");
        } else {
          await expect(result).resolves.toEqual(hosts);
        }
        expect(connection.signal.aborted).toBe(false);
        expect(sourceReleased).toHaveBeenCalledOnce();
        expect(() => retainGatewayDeviceRevocation(caller.isCurrent)).toThrow("no longer active");
      } finally {
        discovery.resolve();
        await Promise.allSettled([result]);
        lifetime.retire();
        lifetime.finishListing();
        caller.release();
      }
    },
  );

  it("preserves the queued caller's plugin scope and retained Gateway root", async () => {
    resetGatewayWorkAdmission();
    const predecessor = tryBeginGatewayRootWorkAdmission("catalog-predecessor")!;
    const requester = tryBeginGatewayRootWorkAdmission("catalog-requester")!;
    const firstRegistry = createEmptyPluginRegistry();
    const queuedRegistry = createEmptyPluginRegistry();
    const gate = createDeferredCore<SessionCatalogHost[]>();
    const blocker = blockedProvider(gate);
    let observedScope: ReturnType<typeof getPluginRuntimeGatewayRequestScope>;
    const retained: { release: (() => void) | null } = { release: null };
    const queued: SessionCatalogProvider = {
      ...blocker,
      id: "queued-catalog",
      list: vi.fn(async () => {
        observedScope = getPluginRuntimeGatewayRequestScope();
        retained.release = retainGatewayRootWorkAdmissionContinuation();
        return [];
      }),
    };
    const active = predecessor.run(async () =>
      inRegistry(firstRegistry, "first-owner", () => Promise.all(occupyProviders(blocker))),
    );
    const pending = requester.run(async () =>
      inRegistry(queuedRegistry, "queued-owner", () => listSessionCatalogProvider(queued, {})),
    );
    try {
      expect(blocker.list).toHaveBeenCalledTimes(16);
      expect(queued.list).not.toHaveBeenCalled();
      gate.resolve([]);
      await Promise.all([active, pending]);

      expect(queued.list).toHaveBeenCalledOnce();
      expect.soft(observedScope?.pluginRegistry).toBe(queuedRegistry);
      expect.soft(observedScope?.pluginId).toBe("queued-owner");
      expect(retained.release).not.toBeNull();
      predecessor.release();
      requester.release();
      expect(getActiveGatewayRootWorkHolders()).toEqual(["catalog-requester"]);
    } finally {
      gate.resolve([]);
      await Promise.allSettled([active, pending]);
      retained.release?.();
      predecessor.release();
      requester.release();
      resetGatewayWorkAdmission();
    }
  });

  it("releases retired queued work before active providers settle", async () => {
    const retirement = new Error("catalog owner retired");
    const before = getActiveGatewayRootWorkHolders();
    const root = tryBeginGatewayRootWorkAdmission("retired-catalog-enumeration")!;
    const gate = createDeferredCore<SessionCatalogHost[]>();
    const blocker = blockedProvider(gate);
    const queued = { ...blocker, id: "retired-catalog", list: vi.fn(async () => []) };
    const successor = { ...blocker, id: "live-catalog", list: vi.fn(async () => []) };
    const activeOwner = new AbortController();
    const active = occupyProviders(blocker, activeOwner.signal);
    const owner = new AbortController();
    const lifetime = new SessionCatalogListLifetime([owner.signal]);
    let retiredErrors: unknown[] | undefined;
    const rejected = root.run(async () => {
      try {
        retiredErrors = await Promise.all(
          Array.from({ length: 32 }, () =>
            lifetime
              .runProvider(undefined, (params) => listSessionCatalogProvider(queued, params))
              .catch((error: unknown) => error),
          ),
        );
      } finally {
        lifetime.finishListing();
        root.release();
      }
    });
    let nextError: unknown;
    let next: Promise<SessionCatalogHost[] | undefined> | undefined;
    try {
      expect(blocker.list).toHaveBeenCalledTimes(16);
      expect(queued.list).not.toHaveBeenCalled();
      await expect
        .soft(listSessionCatalogProvider(queued, { signal: AbortSignal.abort(retirement) }))
        .rejects.toBe(retirement);
      owner.abort(retirement);
      activeOwner.abort(new Error("active providers still own their work"));
      await nextTurn();

      expect.soft(retiredErrors).toHaveLength(32);
      expect.soft(retiredErrors?.every((error) => error === retirement)).toBe(true);
      expect.soft(getActiveGatewayRootWorkHolders()).toEqual(before);
      next = listSessionCatalogProvider(successor, {}).catch((error: unknown) => {
        nextError = error;
        return undefined;
      });
      await nextTurn();
      expect.soft(nextError).toBeUndefined();
      expect(successor.list).not.toHaveBeenCalled();

      gate.resolve([]);
      await rejected;
      expect(queued.list).not.toHaveBeenCalled();
      expect.soft(await next).toEqual([]);
      expect.soft(successor.list).toHaveBeenCalledOnce();
    } finally {
      gate.resolve([]);
      await Promise.allSettled([...active, rejected, ...(next ? [next] : [])]);
      lifetime.finishListing();
      root.release();
    }
  });
});
