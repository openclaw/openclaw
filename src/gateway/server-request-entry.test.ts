import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createInternalAgentTurnFacade } from "./agent-turn/internal-facade.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { NodeRegistry } from "./node-registry.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import { createKernelFixture } from "./server-kernel.fixture-test-support.js";
import { createLazyCoreHandlers } from "./server-methods/lazy-core-handlers.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./server/ws-connection/authenticated-request-dispatch.test-support.js";

const boundaries = vi.hoisted(() => ({
  router: vi.fn<() => Promise<void>>(),
  start: vi.fn<() => Promise<void>>(),
}));

vi.mock(
  "./server/ws-connection/authenticated-request-dispatch.server-methods.runtime.js",
  async () => {
    await boundaries.router();
    return await import("./server-methods.js");
  },
);
vi.mock("./server/ws-connection/request-start.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server/ws-connection/request-start.js")>();
  return {
    ...actual,
    scheduleGatewayRequestStart: (
      ...args: Parameters<typeof actual.scheduleGatewayRequestStart>
    ) => {
      const started = actual.scheduleGatewayRequestStart(...args);
      return started?.then(() => boundaries.start()) ?? null;
    },
  };
});

function profileSync(
  client: ReturnType<typeof createOperatorWsClient>,
  pause: () => Promise<void>,
) {
  return async () => {
    await pause();
    client.authenticatedUserProfile = {
      profileId: "entry-profile",
      displayName: "Entry",
      avatarRevision: "entry-avatar",
      hasAvatar: false,
      updatedAt: 1,
    };
    return { profileId: "entry-profile", updatedAt: 1 };
  };
}

function entryMethods(name: string, handler: GatewayRequestHandler) {
  return createGatewayMethodRegistry([
    { name, owner: { kind: "aux", area: "entry-test" }, scope: "operator.admin", handler },
  ]);
}

const restarting = {
  code: "UNAVAILABLE",
  retryable: true,
  details: { reason: "gateway-restarting" },
};

describe("Gateway request entry lifetime", { concurrent: false }, () => {
  type Fixture = Awaited<ReturnType<typeof createKernelFixture>>;
  let fixture: Fixture;
  let kernel: Awaited<ReturnType<Fixture["open"]>>;
  let releases: (() => void)[];
  let pending: Promise<unknown>[];
  const track = <T>(work: Promise<T>) => {
    pending.push(work);
    return work;
  };
  const createEntryBarrier = () => {
    const held = createDeferredCore();
    const reached = createDeferredCore();
    releases.push(held.resolve);
    return {
      held,
      reached,
      pause: async () => {
        reached.resolve();
        await held.promise;
      },
    };
  };
  const createHarness = (options: Parameters<typeof createDispatchTestHarness>[0]) =>
    createDispatchTestHarness({
      buildRequestContext: () => kernel.gatewayRequestContext,
      ...options,
    });
  const dispatch = (
    harness: ReturnType<typeof createHarness>,
    id: string,
    method = "test.entry",
    client = createOperatorWsClient(),
  ) => {
    void track(harness.awaitResponseFrame(id));
    return track(harness.dispatcher.dispatch({ type: "req", id, method, params: {} }, client));
  };
  const request = (
    method: string,
    options: Partial<Parameters<typeof dispatchGatewayRequestInProcessRaw>[2]> = {},
    params: unknown = {},
  ) =>
    dispatchGatewayRequestInProcessRaw(method, params, {
      context: kernel.gatewayRequestContext,
      client: createOperatorWsClient(),
      ...options,
    });
  const settled = <T>(work: Promise<T>) =>
    work.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

  beforeAll(async () => {
    fixture = await createKernelFixture("gateway-request-entry", {
      layout: "home",
      token: "request-entry-test",
    });
    await fixture.configure();
  });
  beforeEach(async () => {
    releases = [];
    pending = [];
    boundaries.router.mockReset();
    boundaries.start.mockReset();
    kernel = await fixture.open();
    kernel.kernel.setDispatchReady(true);
  });
  afterEach(async () => {
    // Release gates and join requests before disposing the kernel, even after an assertion fails.
    releases.forEach((release) => release());
    try {
      await Promise.all(pending);
      await nextTurn();
    } finally {
      await kernel?.closeOnStartupFailure();
    }
  });
  afterAll(async () => {
    await fixture.state.cleanup();
  });

  it.each(["router", "start", "profile", "family", "family rejection", "nested family"] as const)(
    "joins %s preparation and rejects handler entry before close returns",
    async (boundary) => {
      const { held, reached, pause } = createEntryBarrier();
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
        respond(true, { entered: true }),
      );
      const client = createOperatorWsClient();
      const loadHandlers = async () => {
        if (boundary.includes("family")) {
          await pause();
        }
        if (boundary === "family rejection") {
          throw new Error("expected family preparation failure");
        }
        return { "test.entry": handler };
      };
      const family = { methods: ["test.entry"], loadHandlers };
      const lazy = createLazyCoreHandlers(
        boundary === "nested family"
          ? { ...family, loadHandlers: async () => createLazyCoreHandlers(family) }
          : family,
      );
      if (boundary === "router" || boundary === "start") {
        boundaries[boundary].mockImplementation(pause);
      } else if (boundary === "profile") {
        client.authenticatedGitHubIdentitySync = profileSync(client, pause);
      }
      const harness = createHarness({ extraHandlers: lazy });
      const closed = vi.fn();
      const lateEffects: unknown[] = [];
      const recordLate = (value: unknown) => {
        if (closed.mock.calls.length) {
          lateEffects.push(value);
        }
      };
      harness.send.mockImplementation((frame) => {
        recordLate(frame);
        return { kind: "sent" };
      });
      harness.logGateway.error.mockImplementation(recordLate);
      const dispatched = dispatch(harness, "held", "test.entry", client);
      await reached.promise;
      const closing = track(kernel.prepareClose().then(closed));
      await nextTurn();
      expect.soft(closed).not.toHaveBeenCalled();
      held.resolve();
      const response = await harness.awaitResponseFrame("held");
      if (boundary !== "family rejection") {
        expect.soft(response).toMatchObject({ ok: false, error: restarting });
      }
      await dispatched;
      await closing;
      expect.soft(handler).not.toHaveBeenCalled();
      expect.soft(lateEffects).toEqual([]);
    },
  );

  it.each(["test.entry", "device.token.rotate"])(
    "refuses credential-barrier waiter %s before joining close without draining its predecessor",
    async (method) => {
      const { reached, pause } = createEntryBarrier();
      const mutationFinished = vi.fn();
      const mutation = vi.fn<GatewayRequestHandler>(async ({ respond }) => {
        try {
          await pause();
          respond(true, { mutated: true });
        } finally {
          mutationFinished();
        }
      });
      const waiter = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true));
      const client = createOperatorWsClient();
      const harness = createHarness({
        extraHandlers: { "device.token.revoke": mutation, [method]: waiter },
      });
      const events: string[] = [];
      harness.send.mockImplementation(() => {
        events.push("response");
        return { kind: "sent" };
      });
      void dispatch(harness, "mutation", "device.token.revoke", client);
      await reached.promise;
      void dispatch(harness, "waiting", method, client);
      await nextTurn();
      expect(waiter).not.toHaveBeenCalled();
      expect(harness.send).not.toHaveBeenCalled();
      void track(
        kernel.prepareClose().then(() => {
          events.push("closed");
        }),
      );
      await vi.waitFor(() => expect(events).toContain("closed"));
      expect.soft(events).toEqual(["response", "closed"]);
      expect(harness.send).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "waiting",
          ok: false,
          error: expect.objectContaining(restarting),
        }),
      );
      expect(harness.close).not.toHaveBeenCalled();
      expect(waiter).not.toHaveBeenCalled();
      expect(mutationFinished).not.toHaveBeenCalled();
      expect(mutation.mock.calls[0]?.[0].signal).toBeUndefined();
    },
  );

  it("permits ordinary entry after disconnect while its Gateway is live", async () => {
    const { held, reached, pause } = createEntryBarrier();
    boundaries.start.mockImplementation(pause);
    const socket = new EventEmitter();
    const client = createOperatorWsClient({ socket });
    let disconnected = false;
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { entered: true }));
    const harness = createHarness({
      extraHandlers: { "test.entry": handler },
      isClosed: () => disconnected,
    });
    void dispatch(harness, "disconnected", "test.entry", client);
    await reached.promise;
    disconnected = true;
    socket.emit("close");
    held.resolve();
    expect(await harness.awaitResponseFrame("disconnected")).toMatchObject({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("hands execution off before a handler initiates close", async () => {
    const result = await request("test.close", {
      methodRegistry: entryMethods("test.close", async ({ respond }) => {
        await kernel.prepareClose();
        respond(true, { closed: true });
      }),
    });
    expect(result).toMatchObject({ ok: true, payload: { closed: true } });
  });

  it("admits exact pending node cleanup replies while close drains", async () => {
    const node = createOperatorWsClient({ socket: { readyState: 1, send: vi.fn() } });
    node.connect.role = "node";
    node.connect.client.id = "node-host";
    node.connect.client.mode = "node";
    node.connect.device = {
      id: "entry-node",
      publicKey: "key",
      signature: "sig",
      signedAt: 1,
      nonce: "nonce",
    };
    node.connect.commands = ["debug.ping"];
    const registry = new NodeRegistry({
      resolveCurrentPairingState: async () => ({ identity: "paired", generation: "current" }),
    });
    registry.register(node, { pairingIdentity: "paired", pairingGeneration: "current" });
    const context = { ...kernel.gatewayRequestContext, nodeRegistry: registry };
    const ready = createDeferredCore<string>();
    await kernel.prepareClose();
    markGatewayRestartDraining();
    const invoked = registry.invokeLifecycle({
      nodeId: "entry-node",
      command: "debug.ping",
      timeoutMs: 10_000,
      isDispatchAuthorized: () => true,
      onDispatchReady: ready.resolve,
    });
    const outcome = settled(invoked);
    try {
      const id = await awaitGateBeforeSettlement(ready.promise, outcome, "invoke did not dispatch");
      const response = await request(
        "node.invoke.result",
        { context, client: node },
        { id, nodeId: "entry-node", ok: true },
      );
      expect(response).toMatchObject({ ok: true });
      expect(await outcome).toMatchObject({ value: { ok: true } });
    } finally {
      registry.unregister(node.connId);
      await outcome;
      resetGatewayWorkAdmission();
    }
  });

  it("keeps a retired context closed when a replacement Gateway starts", async () => {
    const retired = kernel.gatewayRequestContext;
    await kernel.closeOnStartupFailure();
    kernel = await fixture.open();
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { entered: true }));
    const methodRegistry = entryMethods("test.entry", handler);
    const options = { client: createOperatorWsClient(), methodRegistry };
    await expect(request("test.entry", { ...options, context: retired })).rejects.toThrow(
      /closed|closing/,
    );
    expect(handler).not.toHaveBeenCalled();
    await expect(request("test.entry", options)).resolves.toMatchObject({ ok: true });
  });

  it("joins typed authorization before allowing its service to start", async () => {
    const { held, reached, pause } = createEntryBarrier();
    const client = createOperatorWsClient();
    client.authenticatedGitHubIdentitySync = profileSync(client, pause);
    const facade = createInternalAgentTurnFacade({
      client,
      getContext: () => kernel.gatewayRequestContext,
    });
    kernel.dedupe.set("agent:entry-typed", { ts: Date.now(), ok: true, payload: { cached: true } });
    const result = facade.dispatchRaw({ message: "cached", idempotencyKey: "entry-typed" });
    const outcome = track(settled(result));
    const closed = vi.fn();
    await reached.promise;
    const closing = track(kernel.prepareClose().then(closed));
    await nextTurn();
    expect.soft(closed).not.toHaveBeenCalled();
    held.resolve();
    expect(await outcome).toMatchObject({
      error: expect.objectContaining({ message: expect.stringMatching(/closed|closing/) }),
    });
    await closing;
  });
});
