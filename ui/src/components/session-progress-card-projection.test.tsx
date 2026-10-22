import { createMemo, createSignal } from "solid-js";
import { afterEach, assert, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ApplicationGateway } from "../app/gateway.ts";
import {
  projectProgressCard,
  type ProgressCardProjectionSource,
} from "../lib/reactive/domain-keyed.ts";
import { sessionProgressCardsForGateway } from "../lib/session-progress-cards.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";

afterEach(() => vi.restoreAllMocks());

function mountProgress(initialSource: ProgressCardProjectionSource) {
  let progress!: ReturnType<typeof projectProgressCard>;
  let replaceSource!: (source: ProgressCardProjectionSource) => void;
  const redraw = vi.fn(
    (snapshot: ReturnType<typeof progress.read>) =>
      `${snapshot.card?.markdown ?? "Loading"} ${snapshot.error ?? ""} ${snapshot.refreshState ?? ""}`,
  );
  const view = mountSolid(() => {
    const [source, setSource] = createSignal(initialSource);
    replaceSource = setSource;
    progress = projectProgressCard(() => ({ ...source() }));
    const content = createMemo(() => redraw(progress.read()));
    return <>{content()}</>;
  });
  flush();
  return { ...view, progress, replaceSource, redraw };
}

function progressGateway(
  handler: Parameters<typeof createTestGatewayClient>[0] = async () => ({ card: null }),
) {
  const request = vi.fn(handler);
  const application = createApplicationGateway();
  Object.assign(application.gateway.snapshot, {
    phase: "connected",
    client: createTestGatewayClient(request),
    hello: gatewayHelloForMethods(["progressCard.get"]),
    assistantAgentId: "main",
  });
  const store = sessionProgressCardsForGateway(application.gateway);
  const emit = (event: string, payload: unknown) =>
    application.publishEvent({ type: "event", event, payload });
  return { ...application, request, store, emit };
}

function requestedSessionKey(params: unknown) {
  const key =
    params && typeof params === "object" && "sessionKey" in params ? params.sessionKey : undefined;
  if (typeof key !== "string") {
    throw new Error("Missing progress-card session key");
  }
  return key;
}

describe("session progress card projection", () => {
  it("keeps source updates detached after explicit disposal while mounted", async () => {
    const { store, request } = progressGateway();
    const subscribe = vi.spyOn(store, "subscribe");
    const target = { sessionKey: "agent:main:disposed-progress" };
    const host = mountProgress({ store, target });
    await waitForSolid(() => expect(host.progress.read().loading).toBe(false));
    expect(request).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();

    host.progress.dispose();
    host.progress.dispose();
    subscribe.mockClear();
    request.mockClear();
    host.replaceSource({ store, target: { sessionKey: "agent:main:retired-progress" } });
    flush();

    expect(subscribe).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("retains same-store snapshots across target changes and observes resets while hidden", async () => {
    const { store, request, emit } = progressGateway(async (_method: string, params?: unknown) => {
      const sessionKey = requestedSessionKey(params);
      const card = { sessionKey, revision: 1, updatedAt: 1, markdown: sessionKey };
      return { card };
    });
    const first = { sessionKey: "agent:main:first-progress" };
    const second = { sessionKey: "agent:main:second-progress" };
    const host = mountProgress({ store, target: first });
    await waitForSolid(() => expect(host.progress.read().card?.sessionKey).toBe(first.sessionKey));
    const { card: firstCard, lifetime: firstLifetime } = host.progress.read();
    expect(firstLifetime).toBeDefined();

    host.replaceSource({ store, target: undefined });
    flush();
    expect(host.progress.read().card).toBeUndefined();
    expect(store.get(first)).toBe(firstCard);
    expect(store.getLifetime(first)).toBe(firstLifetime);

    host.replaceSource({ store, target: second });
    flush();
    await waitForSolid(() => expect(host.progress.read().card?.sessionKey).toBe(second.sessionKey));
    host.replaceSource({ store, target: first });
    flush();
    expect(host.progress.read().card).toBe(firstCard);
    expect(host.progress.read().lifetime).toBe(firstLifetime);
    expect(request).toHaveBeenCalledTimes(2);

    host.replaceSource({ store, target: undefined });
    flush();
    emit("sessions.changed", { sessionKey: first.sessionKey, reason: "reset" });
    expect(store.get(first)).toBeUndefined();
    expect(store.getLifetime(first)).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);

    host.replaceSource({ store, target: first });
    flush();
    await waitForSolid(() => expect(host.progress.read().loading).toBe(false));
    expect(host.progress.read().card).toEqual(firstCard);
    expect(host.progress.read().lifetime).not.toBe(firstLifetime);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("redraws only the watched progress presentation while unrelated sessions change", async () => {
    let revision = 1;
    let readError: Error | undefined;
    const { store, emit } = progressGateway(async (method: string, params?: unknown) => {
      if (method === "progressCard.refresh") {
        return { status: "accepted", runId: "refresh-run", revision };
      }
      if (readError) {
        throw readError;
      }
      const sessionKey = requestedSessionKey(params);
      const card = {
        sessionKey,
        revision,
        updatedAt: revision,
        markdown: `${sessionKey} revision ${revision}`,
      };
      return { card };
    });
    let target = { sessionKey: "agent:main:visible-progress" };
    const host = mountProgress({ store, target });
    const inactive = mountProgress({ store, target: undefined });
    const notified = vi.fn();
    const stop = store.subscribe(notified);
    onTestFinished(stop);
    await store.load(target);
    flush();
    const clearNotifications = () =>
      [host.redraw, inactive.redraw, notified].forEach((mock) => mock.mockClear());
    clearNotifications();
    emit("sessions.changed", { sessionKey: "agent:main:unrelated", reason: "delete" });
    flush();
    expect.soft(notified).not.toHaveBeenCalled();
    expect.soft(host.redraw).not.toHaveBeenCalled();
    clearNotifications();

    await store.load({ sessionKey: "agent:main:other-progress" });
    flush();
    expect(notified).toHaveBeenCalledOnce();
    expect.soft(host.redraw).not.toHaveBeenCalled();
    expect.soft(inactive.redraw).not.toHaveBeenCalled();

    revision = 2;
    emit("progressCard.changed", { sessionKey: target.sessionKey, revision });
    await store.load(target);
    flush();
    expect(host.container.textContent).toContain("visible-progress revision 2");

    const card = host.progress.read().card;
    assert.exists(card, "Expected the displayed progress card");
    store.refresh(target, card);
    flush();
    expect(host.container.textContent).toContain("pending");
    revision = 3;
    emit("progressCard.changed", { sessionKey: target.sessionKey, revision });
    await store.load(target);
    flush();
    expect(host.container.textContent).toContain("updated");

    readError = new Error("Read unavailable");
    emit("progressCard.changed", { sessionKey: target.sessionKey, revision: 4 });
    await expect(store.load(target)).rejects.toThrow("Read unavailable");
    flush();
    expect(host.container.textContent).toContain("unavailable");

    readError = undefined;
    target = { sessionKey: "agent:main:selected-progress" };
    host.replaceSource({ store, target });
    flush();
    await store.load(target);
    flush();
    expect(host.container.textContent).toContain("selected-progress revision 3");
    expect(host.progress.read().error).toBeUndefined();
  });

  it.each([false, true])(
    "waits for renewed view admission across a connection transition (replace client: %s)",
    async (replaceClient) => {
      const { gateway, publish, store, request } = progressGateway();
      let admitted = true;
      const target = { sessionKey: "agent:main:connection-progress" };
      const source = (): ProgressCardProjectionSource => {
        const { client, hello } = gateway.snapshot;
        return {
          store,
          target: admitted ? target : undefined,
          options: {
            admitAutomaticRead: () =>
              admitted && gateway.snapshot.client === client && gateway.snapshot.hello === hello,
          },
        };
      };
      const host = mountProgress(source());
      await waitForSolid(() => expect(host.progress.read().loading).toBe(false));
      expect(request).toHaveBeenCalledTimes(1);

      if (replaceClient) {
        gateway.snapshot.client = createTestGatewayClient(request);
      } else {
        gateway.snapshot.phase = "reconnecting";
        publish(gateway.snapshot);
        gateway.snapshot.phase = "connected";
      }
      gateway.snapshot.hello = gatewayHelloForMethods(["progressCard.get"]);
      publish(gateway.snapshot);
      // The new history is still pending; the Solid owner has not committed the update.
      expect(request).toHaveBeenCalledTimes(1);
      admitted = false;
      host.replaceSource(source());
      flush();
      admitted = true;
      host.replaceSource(source());
      flush();
      await waitForSolid(() => expect(host.progress.read().loading).toBe(false));
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it.each([true, false])(
    "keeps queued updates detached and reconnects once (session target: %s)",
    async (hasTarget) => {
      const target = hasTarget ? { sessionKey: "agent:main:progress-lifecycle" } : undefined;
      const request = vi.fn().mockResolvedValue({ card: null });
      const active = { snapshots: 0, events: 0 };
      const subscribeTo = (kind: keyof typeof active) => () => {
        active[kind] += 1;
        return () => {
          active[kind] -= 1;
        };
      };
      const gateway = {
        snapshot: { phase: "connected", client: { request }, hello: null },
        subscribe: subscribeTo("snapshots"),
        subscribeEvents: subscribeTo("events"),
      } as unknown as ApplicationGateway;
      const store = sessionProgressCardsForGateway(gateway);
      const subscribe = vi.spyOn(store, "subscribe");

      for (let connections = 1; connections <= 2; connections += 1) {
        const host = mountProgress({ store, target });
        if (target) {
          await store.load(target);
          flush();
          expect(host.progress.read().loading).toBe(false);
        }
        expect(subscribe).toHaveBeenCalledTimes(connections);
        expect(request).toHaveBeenCalledTimes(hasTarget ? connections : 0);
        expect(active).toEqual({ snapshots: 1, events: 1 });

        // A queued scope change must not reacquire subscriptions after root disposal.
        host.replaceSource({ store, target: { sessionKey: "agent:main:queued-progress" } });
        host.unmount();
        expect(active).toEqual({ snapshots: 0, events: 0 });
        flush();
        expect(active).toEqual({ snapshots: 0, events: 0 });
        expect(subscribe).toHaveBeenCalledTimes(connections);
        expect(request).toHaveBeenCalledTimes(hasTarget ? connections : 0);
      }
    },
  );
});
