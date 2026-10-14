import type { ProgressCardGetParams } from "@openclaw/gateway-protocol";
import { createMemo } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ApplicationGateway } from "../app/gateway.ts";
import { sessionProgressCardsForGateway } from "../lib/session-progress-cards.ts";
import { useSolidControllerHost, type SolidControllerHost } from "../lit/solid-controller-host.ts";
import { ControllerHost } from "../lit/subscriptions-controller.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { SessionProgressCardController } from "./session-progress-card-controller.ts";

function mountProgress(
  gateway: ApplicationGateway,
  target: () => ProgressCardGetParams | null | undefined,
) {
  let progress!: SessionProgressCardController;
  let host!: SolidControllerHost;
  const redraw = vi.fn(
    () =>
      `${progress.card?.markdown ?? "Loading"} ${progress.error ?? ""} ${progress.refreshState ?? ""}`,
  );
  const view = mountSolid(() => {
    const owner = useSolidControllerHost();
    host = owner.host;
    progress = new SessionProgressCardController(host, { gateway: () => gateway, target });
    const content = createMemo(() => {
      owner.revision();
      return redraw();
    });
    return <>{content()}</>;
  });
  flush();
  return { ...view, progress, host, redraw };
}

describe("SessionProgressCardController", () => {
  it("redraws only the watched progress presentation while unrelated sessions change", async () => {
    let revision = 1;
    let readError: Error | undefined;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "progressCard.refresh") {
        return { status: "accepted", runId: "refresh-run", revision };
      }
      if (readError) {
        throw readError;
      }
      if (
        !params ||
        typeof params !== "object" ||
        !("sessionKey" in params) ||
        typeof params.sessionKey !== "string"
      ) {
        throw new Error("Missing progress-card session key");
      }
      return {
        card: {
          sessionKey: params.sessionKey,
          revision,
          updatedAt: revision,
          markdown: `${params.sessionKey} revision ${revision}`,
        },
      };
    });
    const { gateway, publishEvent } = createApplicationGateway({
      phase: "connected",
      client: createTestGatewayClient(request),
      hello: gatewayHelloForMethods(["progressCard.get"]),
      offlineStable: false,
      canvasPluginSurfaceUrl: null,
      assistantAgentId: "main",
      sessionKey: "",
      lastError: null,
      lastErrorCode: null,
    });
    let target = { sessionKey: "agent:main:visible-progress" };
    const host = mountProgress(gateway, () => target);
    const inactive = mountProgress(gateway, () => undefined);
    const store = sessionProgressCardsForGateway(gateway);
    const notified = vi.fn();
    const stop = store.subscribe(notified);
    onTestFinished(() => {
      host.unmount();
      inactive.unmount();
      stop();
      vi.restoreAllMocks();
    });
    await store.load(target);
    flush();
    const { redraw } = host;
    const { redraw: inactiveRedraw } = inactive;
    redraw.mockClear();
    inactiveRedraw.mockClear();
    notified.mockClear();
    publishEvent({
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: "agent:main:unrelated", reason: "delete" },
    });
    flush();
    expect.soft(notified).not.toHaveBeenCalled();
    expect.soft(redraw).not.toHaveBeenCalled();
    notified.mockClear();
    redraw.mockClear();
    inactiveRedraw.mockClear();

    await store.load({ sessionKey: "agent:main:other-progress" });
    flush();
    expect(notified).toHaveBeenCalledOnce();
    expect.soft(redraw).not.toHaveBeenCalled();
    expect.soft(inactiveRedraw).not.toHaveBeenCalled();

    revision = 2;
    publishEvent({
      type: "event",
      event: "progressCard.changed",
      payload: { sessionKey: target.sessionKey, revision },
    });
    await store.load(target);
    flush();
    expect(host.container.textContent).toContain("visible-progress revision 2");

    const card = host.progress.card;
    if (!card) {
      throw new Error("Expected the displayed progress card");
    }
    host.progress.refresh(card);
    flush();
    expect(host.container.textContent).toContain("pending");
    revision = 3;
    publishEvent({
      type: "event",
      event: "progressCard.changed",
      payload: { sessionKey: target.sessionKey, revision },
    });
    await store.load(target);
    flush();
    expect(host.container.textContent).toContain("updated");

    readError = new Error("Read unavailable");
    publishEvent({
      type: "event",
      event: "progressCard.changed",
      payload: { sessionKey: target.sessionKey, revision: 4 },
    });
    await expect(store.load(target)).rejects.toThrow("Read unavailable");
    flush();
    expect(host.container.textContent).toContain("unavailable");

    readError = undefined;
    target = { sessionKey: "agent:main:selected-progress" };
    host.host.requestUpdate();
    flush();
    await store.load(target);
    flush();
    expect(host.container.textContent).toContain("selected-progress revision 3");
    expect(host.progress.error).toBeUndefined();
  });

  it.each([false, true])(
    "waits for renewed view admission across a connection transition (replace client: %s)",
    async (replaceClient) => {
      const request = vi.fn().mockResolvedValue({ card: null });
      const snapshots = new Set<Parameters<ApplicationGateway["subscribe"]>[0]>();
      const gateway = {
        snapshot: {
          phase: "connected",
          client: createTestGatewayClient(request),
          hello: gatewayHelloForMethods(["progressCard.get"]),
        },
        subscribe: (listener: Parameters<ApplicationGateway["subscribe"]>[0]) => {
          snapshots.add(listener);
          return () => snapshots.delete(listener);
        },
        subscribeEvents: () => () => undefined,
      } as unknown as ApplicationGateway;
      let admitted = true;
      const host = mountProgress(gateway, () =>
        admitted ? { sessionKey: "agent:main:connection-progress" } : null,
      );
      onTestFinished(host.unmount);
      await waitForSolid(() => expect(host.progress.loading).toBe(false));
      expect(request).toHaveBeenCalledTimes(1);

      if (replaceClient) {
        gateway.snapshot.client = createTestGatewayClient(request);
      } else {
        gateway.snapshot.phase = "reconnecting";
        for (const listener of snapshots) {
          listener(gateway.snapshot);
        }
        gateway.snapshot.phase = "connected";
      }
      gateway.snapshot.hello = gatewayHelloForMethods(["progressCard.get"]);
      for (const listener of snapshots) {
        listener(gateway.snapshot);
      }
      // The new history is still pending; the Solid owner has not committed the update.
      expect(request).toHaveBeenCalledTimes(1);
      admitted = false;
      flush();
      admitted = true;
      host.host.requestUpdate();
      flush();
      await waitForSolid(() => expect(host.progress.loading).toBe(false));
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it.each([true, false])(
    "keeps queued updates detached and reconnects once (session target: %s)",
    async (hasTarget) => {
      const target = hasTarget ? { sessionKey: "agent:main:progress-lifecycle" } : null;
      const request = vi.fn().mockResolvedValue({ card: null });
      const active = { snapshots: 0, events: 0 };
      const gateway = {
        snapshot: { phase: "connected", client: { request }, hello: null },
        subscribe: () => {
          active.snapshots += 1;
          return () => {
            active.snapshots -= 1;
          };
        },
        subscribeEvents: () => {
          active.events += 1;
          return () => {
            active.events -= 1;
          };
        },
      } as unknown as ApplicationGateway;
      const store = sessionProgressCardsForGateway(gateway);
      const subscribe = vi.spyOn(store, "subscribe");
      const watch = vi.spyOn(store, "watch");
      const host = new ControllerHost();
      const progress = new SessionProgressCardController(host, {
        gateway: () => gateway,
        target: () => target,
      });
      onTestFinished(() => {
        host.disconnect();
        vi.restoreAllMocks();
      });

      for (let connections = 1; connections <= 2; connections += 1) {
        host.connect();
        await host.updateComplete;
        if (target) {
          await store.load(target);
          await host.updateComplete;
          expect(progress.loading).toBe(false);
        }
        expect(subscribe).toHaveBeenCalledTimes(connections);
        expect(watch).toHaveBeenCalledTimes(hasTarget ? connections : 0);
        expect(request).toHaveBeenCalledTimes(hasTarget ? connections : 0);
        expect(active).toEqual({ snapshots: 1, events: 1 });

        // Chat reconnects this same host after retiring its queued update.
        host.requestUpdate();
        const queuedUpdate = host.updateComplete;
        host.disconnect();
        expect(active).toEqual({ snapshots: 0, events: 0 });
        await queuedUpdate;
        expect(host.isConnected).toBe(false);
        expect(active).toEqual({ snapshots: 0, events: 0 });
        expect(subscribe).toHaveBeenCalledTimes(connections);
        expect(watch).toHaveBeenCalledTimes(hasTarget ? connections : 0);
        expect(request).toHaveBeenCalledTimes(hasTarget ? connections : 0);
      }
    },
  );
});
