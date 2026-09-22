import { LitElement } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ApplicationGateway } from "../app/gateway.ts";
import { sessionProgressCardsForGateway } from "../lib/session-progress-cards.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { SessionProgressCardController } from "./session-progress-card-controller.ts";

describe("SessionProgressCardController", () => {
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
      class ProgressHost extends LitElement {
        readonly progress = new SessionProgressCardController(this, {
          gateway: () => gateway,
          target: () => (admitted ? { sessionKey: "agent:main:connection-progress" } : null),
        });
      }
      customElements.define(`test-progress-reconnect-${replaceClient}`, ProgressHost);
      const host = new ProgressHost();
      onTestFinished(() => host.remove());
      document.body.append(host);
      await host.updateComplete;
      await vi.waitFor(() => expect(host.progress.loading).toBe(false));
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
      // The new history is still pending; no Lit update has had a chance to run.
      expect(request).toHaveBeenCalledTimes(1);
      admitted = false;
      await host.updateComplete;
      admitted = true;
      host.requestUpdate();
      await host.updateComplete;
      await vi.waitFor(() => expect(host.progress.loading).toBe(false));
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
      class ProgressHost extends LitElement {
        readonly progress = new SessionProgressCardController(this, {
          gateway: () => gateway,
          target: () => target,
        });
      }
      customElements.define(`test-progress-controller-${hasTarget}`, ProgressHost);
      const host = new ProgressHost();
      onTestFinished(() => {
        host.remove();
        vi.restoreAllMocks();
      });

      for (let connections = 1; connections <= 2; connections += 1) {
        document.body.append(host);
        await host.updateComplete;
        if (target) {
          await store.load(target);
          await host.updateComplete;
        }
        expect(subscribe).toHaveBeenCalledTimes(connections);
        expect(watch).toHaveBeenCalledTimes(hasTarget ? connections : 0);
        expect(request).toHaveBeenCalledTimes(hasTarget ? connections : 0);
        expect(active).toEqual({ snapshots: 1, events: 1 });

        // Lit still flushes this update after disconnectedCallback has released the store.
        host.requestUpdate();
        expect(host.isUpdatePending).toBe(true);
        host.remove();
        expect(active).toEqual({ snapshots: 0, events: 0 });
        await host.updateComplete;
        expect(host.isConnected).toBe(false);
        expect(active).toEqual({ snapshots: 0, events: 0 });
        expect(subscribe).toHaveBeenCalledTimes(connections);
        expect(watch).toHaveBeenCalledTimes(hasTarget ? connections : 0);
        expect(request).toHaveBeenCalledTimes(hasTarget ? connections : 0);
      }
    },
  );
});
