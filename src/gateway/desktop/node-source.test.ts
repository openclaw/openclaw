import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../shared/node-desktop-stream.js";
import { NodeRegistry } from "../node-registry.js";
import { createWorkerSupervisorNodeClient } from "../server-methods/nodes.runner-inventory.test-support.js";
import { createNodeDesktopService } from "./node-source.js";
import { createNodeDesktopStreamBroker } from "./node-stream-broker.js";
import * as observeBridge from "./observe-bridge.js";
import type { DesktopObserveRequester } from "./observe-requester.js";
import { createDesktopSessionRegistry } from "./session-registry.js";

const cleanups: Array<() => Promise<void>> = [];
const credentials = { password: "synthetic-password" };

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

function createRequester() {
  const controller = new AbortController();
  return {
    controller,
    identity: { signal: controller.signal, isCurrent: () => !controller.signal.aborted },
  };
}

const rejected = (promise: Promise<unknown>) => promise.then(() => false).catch(() => true);

function createFixture(boundary: "activation" | "pairing" | "attachment") {
  let config: OpenClawConfig = {};
  const reached = createDeferred();
  const release = createDeferred();
  const forwarded: string[] = [];
  const nodeRegistry = new NodeRegistry({
    resolveCurrentPairingState: async () => {
      if (boundary === "pairing") {
        reached.resolve();
        await release.promise;
      }
      return { identity: "identity", generation: "generation" };
    },
  });
  const client = createWorkerSupervisorNodeClient("node-conn");
  delete client.connect.caps;
  client.connect.commands = [NODE_DESKTOP_STREAM_COMMAND];
  client.connect.client.deviceFamily = "Linux";
  client.socket.send = (frame) => {
    const event = JSON.parse(String(frame)) as {
      event: string;
      payload: { command: string };
    };
    if (event.event !== "node.invoke.request") {
      return;
    }
    forwarded.push(event.payload.command);
    expect(boundary).toBe("attachment");
    reached.resolve();
  };
  const node = nodeRegistry.register(client, {
    pairingIdentity: "identity",
    pairingGeneration: "generation",
  });
  const desktopRegistry = createDesktopSessionRegistry();
  if (boundary === "activation") {
    const activate = desktopRegistry.activate;
    vi.spyOn(desktopRegistry, "activate").mockImplementation(async (request) => {
      await activate(request);
      reached.resolve();
      await release.promise;
    });
  }
  const streamBroker = createNodeDesktopStreamBroker();
  const attached = createDeferred<Awaited<ReturnType<typeof streamBroker.mint>["attached"]>>();
  if (boundary === "attachment") {
    vi.spyOn(streamBroker, "mint").mockReturnValue({
      ticket: "synthetic-ticket",
      attachPath: "/synthetic-attach",
      expiresAtMs: Date.now() + 60_000,
      attached: attached.promise,
      cancel: () => attached.reject(new Error("cancelled")),
    });
  }
  const service = createNodeDesktopService({
    getConfig: () => config,
    nodeRegistry,
    desktopRegistry,
    streamBroker,
  });
  cleanups.push(async () => {
    release.resolve();
    await desktopRegistry.stopAll();
    nodeRegistry.unregister(client.connId);
  });
  const observe = (overrides: Partial<Parameters<typeof service.observe>[0]> = {}) =>
    service.observe({ nodeId: "node-1", control: false, ...overrides });
  return {
    node,
    stop: () => service.stopNode("node-1"),
    observe,
    async observeAttached(identity?: DesktopObserveRequester, stream = new PassThrough()) {
      const pending = observe({ credentials, requester: identity });
      await reached.promise;
      attached.resolve({ stream, auth: "vnc-password" });
      return pending;
    },
    nodeRegistry,
    desktopRegistry,
    reached: reached.promise,
    release: release.resolve,
    attached,
    forwarded,
    revoke() {
      config = { gateway: { nodes: { commands: { deny: [NODE_DESKTOP_STREAM_COMMAND] } } } };
    },
  };
}

it("refuses an advertised desktop without pairing approval", async () => {
  const fixture = createFixture("attachment");
  fixture.node.pairingGeneration = undefined;
  await expect(fixture.observe()).rejects.toThrow("reconnect and approve the node capability");
  expect(fixture.forwarded).toEqual([]);
});

it.each(["release", "stop"] as const)(
  "joins invocation settlement when owner stop overlaps %s",
  async (firstAction) => {
    const fixture = createFixture("attachment");
    const mint = vi.spyOn(observeBridge, "mintDesktopObserverToken");
    const canceled = createDeferred();
    const finishInvocation = createDeferred();
    const completionOrder: string[] = [];
    const invoke = fixture.nodeRegistry.invoke.bind(fixture.nodeRegistry);
    vi.spyOn(fixture.nodeRegistry, "invoke").mockImplementation(async (request) => {
      const result = await invoke(request);
      canceled.resolve();
      await finishInvocation.promise;
      completionOrder.push("invocation");
      return result;
    });
    const { controller, identity } = createRequester();
    let current = true;
    const owner = { ...identity, connId: "desktop-panel-client", isCurrent: () => current };
    try {
      const observed = await fixture.observeAttached(owner);
      const mintedRequester = mint.mock.calls[0]?.[0].requester;
      expect(mintedRequester).toBe(owner);
      expect(mintedRequester?.isCurrent()).toBe(true);
      current = false;
      expect(mintedRequester?.isCurrent()).toBe(false);
      expect(controller.signal.aborted).toBe(false);
      current = true;
      const retiring = (
        firstAction === "release"
          ? observeBridge.releaseDesktopObserverToken(observed.wsPath, owner)
          : fixture.stop()
      ).then((result) => {
        completionOrder.push(firstAction);
        return result;
      });
      await canceled.promise;
      const stopping = fixture.stop().then(() => {
        completionOrder.push("stop");
      });
      await setImmediate();
      finishInvocation.resolve();
      expect(await retiring).toBe(firstAction === "release" ? true : undefined);
      await stopping;
      expect(completionOrder[0]).toBe("invocation");
    } finally {
      finishInvocation.resolve();
      controller.abort();
    }
  },
);

it.each([false, true])("expires only unclaimed streams (claimed=%s)", async (claimed) => {
  vi.useFakeTimers();
  const fixture = createFixture("attachment");
  const mint = vi.spyOn(observeBridge, "mintDesktopObserverToken");
  const invoke = vi.spyOn(fixture.nodeRegistry, "invoke");
  const stream = new PassThrough();
  try {
    const observed = await fixture.observeAttached(undefined, stream);
    const token = mint.mock.calls[0]![0];
    if (claimed) {
      if (token.attachment.kind !== "stream") {
        throw new Error("expected a streamed node desktop");
      }
      expect(fixture.desktopRegistry.claimStream(token.sourceKey, token.attachment)).toBe(stream);
      expect(
        fixture.desktopRegistry.attachObserver(token.sourceKey, {
          ownerEpoch: token.ownerEpoch,
          control: false,
          close: () => {},
        }),
      ).toBeDefined();
    }
    await vi.advanceTimersByTimeAsync(observed.expiresAtMs - Date.now());
    expect(stream.destroyed).toBe(!claimed);
    expect(fixture.desktopRegistry.hasActivity(token.sourceKey, token.ownerEpoch)).toBe(claimed);
    if (!claimed) {
      await expect(invoke.mock.results[0]!.value).resolves.toMatchObject({ ok: false });
    }
  } finally {
    await fixture.stop();
    vi.useRealTimers();
  }
});

it.each([
  { boundary: "activation", revoked: "requester" },
  { boundary: "activation", revoked: "policy" },
  { boundary: "pairing", revoked: "policy" },
  { boundary: "attachment", revoked: "policy" },
] as const)("rejects $revoked revocation during $boundary", async ({ boundary, revoked }) => {
  const fixture = createFixture(boundary);
  const { controller, identity } = createRequester();
  const observed = rejected(
    fixture.observe({ credentials, requester: revoked === "requester" ? identity : undefined }),
  );
  await fixture.reached;
  if (revoked === "requester") {
    controller.abort();
  } else {
    fixture.revoke();
  }
  const stream = boundary === "attachment" ? new PassThrough() : undefined;
  if (stream) {
    fixture.attached.resolve({ stream, auth: "vnc-password" });
  } else {
    fixture.release();
  }
  expect(await observed).toBe(true);
  if (stream) {
    expect(stream.destroyed).toBe(true);
  } else {
    expect(fixture.forwarded).toEqual([]);
  }
});

it("settles a canceled observer while its node pairing lookup is still pending", async () => {
  const fixture = createFixture("pairing");
  const { controller, identity } = createRequester();
  const observed = rejected(fixture.observe({ requester: identity }));
  await fixture.reached;
  controller.abort();
  expect(await observed).toBe(true);
  expect(fixture.forwarded).toEqual([]);
  fixture.release();
  await Promise.resolve();
  expect(fixture.forwarded).toEqual([]);
});
