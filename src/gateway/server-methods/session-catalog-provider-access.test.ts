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
import { SessionCatalogListLifetime } from "./session-catalog-list-lifetime.js";
import { listSessionCatalogProvider } from "./session-catalog-provider-access.js";

describe("session catalog provider admission", () => {
  it("preserves the queued caller's plugin scope and retained Gateway root", async () => {
    resetGatewayWorkAdmission();
    const predecessor = tryBeginGatewayRootWorkAdmission("catalog-predecessor")!;
    const requester = tryBeginGatewayRootWorkAdmission("catalog-requester")!;
    const firstRegistry = createEmptyPluginRegistry();
    const queuedRegistry = createEmptyPluginRegistry();
    const gate = createDeferredCore<SessionCatalogHost[]>();
    const blocker: SessionCatalogProvider = {
      id: "blocking-catalog",
      label: "Blocking catalog",
      list: vi.fn(() => gate.promise),
      read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
    };
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
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: firstRegistry, pluginId: "first-owner", isWebchatConnect: () => false },
        () => Promise.all(Array.from({ length: 4 }, () => listSessionCatalogProvider(blocker, {}))),
      ),
    );
    const pending = requester.run(async () =>
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: queuedRegistry, pluginId: "queued-owner", isWebchatConnect: () => false },
        () => listSessionCatalogProvider(queued, {}),
      ),
    );
    try {
      expect(blocker.list).toHaveBeenCalledTimes(4);
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

  it.each([
    { kind: "Error", reason: new Error("catalog owner retired") },
    { kind: "string", reason: "catalog owner retired" },
  ])(
    "releases retired queued work before active providers settle ($kind)",
    async ({ reason: retirement }) => {
      const before = getActiveGatewayRootWorkHolders();
      const root = tryBeginGatewayRootWorkAdmission("retired-catalog-enumeration")!;
      const gate = createDeferredCore<SessionCatalogHost[]>();
      const blocker: SessionCatalogProvider = {
        id: "blocking-catalog",
        label: "Blocking catalog",
        list: vi.fn(() => gate.promise),
        read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
      };
      const queued = { ...blocker, id: "retired-catalog", list: vi.fn(async () => []) };
      const successor = { ...blocker, id: "live-catalog", list: vi.fn(async () => []) };
      const activeOwner = new AbortController();
      const active = Array.from({ length: 4 }, () =>
        listSessionCatalogProvider(blocker, { signal: activeOwner.signal }),
      );
      const owner = new AbortController();
      const lifetime = new SessionCatalogListLifetime(() => true, [owner.signal]);
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
        expect(blocker.list).toHaveBeenCalledTimes(4);
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
    },
  );
});
