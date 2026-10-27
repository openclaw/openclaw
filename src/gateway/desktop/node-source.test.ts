import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, assert, expect, it, vi } from "vitest";
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

const cleanups: Array<() => void | Promise<void>> = [];
const credentials = { password: "synthetic-password" };

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function createRequester() {
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  return Object.assign(controller, { isCurrent: () => !controller.signal.aborted });
}

const rejected = (promise: Promise<unknown>) => promise.then(() => false).catch(() => true);

function createFixture(boundary: "activation" | "pairing" | "attachment") {
  let config: OpenClawConfig = {};
  const gate = { reached: createDeferred(), release: createDeferred() };
  const hold = async <T>(value: T) => {
    gate.reached.resolve();
    await gate.release.promise;
    return value;
  };
  const forwarded = vi.fn(() => gate.reached.resolve());
  const pairing = { identity: "identity", generation: "generation" };
  const nodeRegistry = new NodeRegistry({
    resolveCurrentPairingState: async () => (boundary === "pairing" ? hold(pairing) : pairing),
  });
  const client = createWorkerSupervisorNodeClient("node-conn");
  client.connect.commands = [NODE_DESKTOP_STREAM_COMMAND];
  client.connect.client.deviceFamily = "Linux";
  client.socket.send = forwarded;
  nodeRegistry.register(client, {
    pairingIdentity: "identity",
    pairingGeneration: "generation",
  });
  const desktopRegistry = createDesktopSessionRegistry();
  if (boundary === "activation") {
    const activate = desktopRegistry.activate;
    vi.spyOn(desktopRegistry, "activate").mockImplementation((request) =>
      activate(request).then(hold),
    );
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
    gate.release.resolve();
    await desktopRegistry.stopAll();
    nodeRegistry.unregister(client.connId);
  });
  return {
    stop: () => service.stopNode("node-1"),
    observe: async (requester?: DesktopObserveRequester, stream?: PassThrough) => {
      const pending = service.observe({ nodeId: "node-1", control: false, credentials, requester });
      if (stream) {
        await gate.reached.promise;
        attached.resolve({ stream, auth: "vnc-password" });
      }
      return pending;
    },
    nodeRegistry,
    desktopRegistry,
    gate,
    attached,
    forwarded,
    revoke() {
      config = { gateway: { nodes: { commands: { deny: [NODE_DESKTOP_STREAM_COMMAND] } } } };
    },
  };
}

it("refuses an advertised desktop without pairing approval", async () => {
  const fixture = createFixture("attachment");
  fixture.nodeRegistry.get("node-1")!.pairingGeneration = undefined;
  await expect(fixture.observe()).rejects.toThrow("reconnect and approve the node capability");
  expect(fixture.forwarded).not.toHaveBeenCalled();
});

it("joins invocation settlement when owner stop overlaps release", async () => {
  const fixture = createFixture("attachment");
  const canceled = createDeferred();
  const finishInvocation = createDeferred();
  cleanups.push(finishInvocation.resolve);
  const completionOrder: string[] = [];
  const invoke = fixture.nodeRegistry.invoke.bind(fixture.nodeRegistry);
  vi.spyOn(fixture.nodeRegistry, "invoke").mockImplementation(async (request) => {
    const result = await invoke(request);
    canceled.resolve();
    await finishInvocation.promise;
    completionOrder.push("invocation");
    return result;
  });
  const owner = Object.assign(createRequester(), { connId: "desktop-panel-client" });
  const observed = await fixture.observe(owner, new PassThrough());
  const retiring = observeBridge
    .releaseDesktopObserverToken(observed.wsPath, owner)
    .finally(() => completionOrder.push("release"));
  await canceled.promise;
  const stopping = fixture.stop().then(() => completionOrder.push("stop"));
  await setImmediate();
  finishInvocation.resolve();
  expect(await retiring).toBe(true);
  await stopping;
  expect(completionOrder[0]).toBe("invocation");
});

it.each([false, true])("expires only unclaimed streams (claimed=%s)", async (claimed) => {
  vi.useFakeTimers();
  const { desktopRegistry: registry, observe, nodeRegistry } = createFixture("attachment");
  const mint = vi.spyOn(observeBridge, "mintDesktopObserverToken");
  const invoke = vi.spyOn(nodeRegistry, "invoke");
  const stream = new PassThrough();
  const observed = await observe(undefined, stream);
  const { attachment, sourceKey, ownerEpoch } = mint.mock.calls[0]![0];
  if (claimed) {
    assert(attachment.kind === "stream", "expected a streamed node desktop");
    expect(registry.claimStream(sourceKey, attachment)).toBe(stream);
    const observer = registry.attachObserver(sourceKey, { ownerEpoch, control: false, close() {} });
    expect(observer).toBeDefined();
  }
  await vi.advanceTimersByTimeAsync(observed.expiresAtMs - Date.now());
  expect(stream.destroyed).toBe(!claimed);
  expect(registry.hasActivity(sourceKey, ownerEpoch)).toBe(claimed);
  if (!claimed) {
    await expect(invoke.mock.results[0]!.value).resolves.toMatchObject({ ok: false });
  }
});

it.each([
  { boundary: "activation", revoked: "requester" },
  { boundary: "activation", revoked: "policy" },
  { boundary: "pairing", revoked: "requester" },
  { boundary: "pairing", revoked: "policy" },
  { boundary: "attachment", revoked: "policy" },
] as const)("rejects $revoked revocation during $boundary", async ({ boundary, revoked }) => {
  const fixture = createFixture(boundary);
  const requester = createRequester();
  const observed = rejected(fixture.observe(revoked === "requester" ? requester : undefined));
  await fixture.gate.reached.promise;
  if (revoked === "requester") {
    requester.abort();
    if (boundary === "pairing") {
      expect(await observed).toBe(true);
      expect(fixture.forwarded).not.toHaveBeenCalled();
    }
  } else {
    fixture.revoke();
  }
  const stream = boundary === "attachment" ? new PassThrough() : undefined;
  if (stream) {
    fixture.attached.resolve({ stream, auth: "vnc-password" });
  } else {
    fixture.gate.release.resolve();
  }
  expect(await observed).toBe(true);
  if (stream) {
    expect(stream.destroyed).toBe(true);
  } else {
    await Promise.resolve();
    expect(fixture.forwarded).not.toHaveBeenCalled();
  }
});
