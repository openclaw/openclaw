import assert from "node:assert/strict";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import type { RecoveryFixtureFactory } from "./server-plugin-reload.recovery.test-support.js";

type RecoveryFixture = Awaited<ReturnType<RecoveryFixtureFactory>>;

async function readResource(fixture: RecoveryFixture) {
  const method = "first.resource";
  const handler = fixture.registryOwner.registry.gatewayHandlers[method];
  assert(handler);
  const respond = vi.fn();
  await handler({
    req: { type: "req", id: "resource-reload", method },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as GatewayRequestHandlerOptions["context"],
  });
  expect(respond).toHaveBeenCalledOnce();
  return respond.mock.calls[0]?.[1];
}

function resourceConfig(mode: string): OpenClawConfig {
  return {
    plugins: {
      allow: ["first", "sibling"],
      entries: { first: { config: { mode } } },
    },
  };
}

export async function verifySharedResourceReplacement(
  createFixture: RecoveryFixtureFactory,
  cleanup: "gateway_stop" | "dispose",
) {
  const events: string[] = [];
  let shared: { closed: boolean; mode: unknown } | undefined;
  const fixture = await createFixture({
    config: resourceConfig("old"),
    abortOnCandidateStart: false,
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
      const mode = api.config.plugins?.entries?.first?.config?.mode;
      assert(typeof mode === "string");
      events.push(`register:${mode}`);
      const borrowed = shared;
      const resource = borrowed ?? { closed: false, mode };
      shared = resource;
      api.registerGatewayMethod("first.resource", ({ respond }) => {
        if (resource.closed) {
          throw new Error("shared connection was closed by the previous registration");
        }
        respond(true, { mode: resource.mode });
      });
      // Published Lossless similarly borrows the owner's engine and returns before
      // registering lifecycle hooks when the same database path is already open.
      if (borrowed) {
        return;
      }
      const close = () => {
        events.push(`stop:${mode}`);
        resource.closed = true;
        shared = undefined;
      };
      if (cleanup === "gateway_stop") {
        api.on("gateway_stop", close);
      } else {
        assert(api.lifecycle.onDispose);
        api.lifecycle.onDispose(close);
      }
    },
  });
  const sibling = fixture.previousRegistry.plugins.find((record) => record.id === "sibling");
  expect(await readResource(fixture)).toEqual({ mode: "old" });

  await fixture.reload(resourceConfig("new"), ["first"], ["plugins.entries.first.config.mode"]);

  expect(await readResource(fixture)).toEqual({ mode: "new" });
  expect(events).toEqual(["register:old", "stop:old", "register:new"]);
  expect(fixture.registryOwner.registry.plugins.find((record) => record.id === "sibling")).toBe(
    sibling,
  );
  expect(fixture.siblingStart).toHaveBeenCalledOnce();
  expect(fixture.siblingStop).not.toHaveBeenCalled();
}

export async function verifyFreshRegistrationRecovery(
  createFixture: RecoveryFixtureFactory,
  failure: "registration" | "activation",
) {
  const events: string[] = [];
  const signals: AbortSignal[] = [];
  const fixture = await createFixture({
    config: resourceConfig("old"),
    abortOnCandidateStart: false,
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
      const mode = api.config.plugins?.entries?.first?.config?.mode;
      assert(typeof mode === "string");
      const controller = new AbortController();
      signals.push(controller.signal);
      events.push(`register:${mode}`);
      assert(api.lifecycle.onDispose);
      api.lifecycle.onDispose(() => {
        controller.abort();
        events.push(`dispose:${mode}`);
      });
      if (mode === "bad" && failure === "registration") {
        throw new Error("candidate registration refused");
      }
      api.registerService({
        id: "non-restartable-resource",
        start() {
          // Like Visitor Access, this registration cannot restart after its
          // controller has been aborted; rollback must create a fresh owner.
          if (controller.signal.aborted) {
            throw new Error("cannot restart an aborted registration");
          }
          if (mode === "bad") {
            throw new Error("candidate activation refused");
          }
          events.push(`start:${mode}`);
        },
      });
      api.on("gateway_stop", () => {
        controller.abort();
        events.push(`stop:${mode}`);
      });
      api.registerGatewayMethod("first.resource", ({ respond }) => {
        if (controller.signal.aborted) {
          throw new Error("registration is stopped");
        }
        respond(true, { mode });
      });
    },
  });
  const sibling = fixture.previousRegistry.plugins.find((record) => record.id === "sibling");
  expect(await readResource(fixture)).toEqual({ mode: "old" });

  await expect(fixture.reload(resourceConfig("bad"))).rejects.toThrow(
    `candidate ${failure} refused`,
  );

  expect(await readResource(fixture)).toEqual({ mode: "old" });
  expect(fixture.getConfig()).toEqual(resourceConfig("old"));
  expect(events.filter((event) => event.startsWith("register:"))).toEqual([
    "register:old",
    "register:bad",
    "register:old",
  ]);
  expect(events.indexOf("stop:old")).toBeLessThan(events.indexOf("register:bad"));
  expect(events.indexOf("dispose:bad")).toBeLessThan(events.lastIndexOf("register:old"));
  expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false]);
  expect(fixture.registryOwner.registry.plugins.find((record) => record.id === "sibling")).toBe(
    sibling,
  );
  expect(fixture.siblingStart).toHaveBeenCalledOnce();
  expect(fixture.siblingStop).not.toHaveBeenCalled();
}

export async function verifyCandidateResourceCleanup(createFixture: RecoveryFixtureFactory) {
  const resources: Array<{ closed: boolean; flushed: boolean }> = [];
  const fixture = await createFixture({
    abortOnCandidateStart: false,
    beforePublish: async () => {
      throw new Error("candidate publication refused");
    },
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
      const resource = { closed: false, flushed: false };
      resources.push(resource);
      api.registerService({
        id: "resource-consumer",
        start() {},
        stop() {
          if (resource.closed) {
            throw new Error("cannot flush a closed connection");
          }
          resource.flushed = true;
        },
      });
      const close = () => {
        resource.closed = true;
      };
      api.on("gateway_stop", close);
      assert(api.lifecycle.onDispose);
      api.lifecycle.onDispose(close);
    },
  });

  await expect(fixture.reload()).rejects.toThrow("candidate publication refused");

  expect(resources).toEqual([
    { closed: true, flushed: true },
    { closed: true, flushed: true },
    { closed: false, flushed: false },
  ]);
  expect(fixture.firstStart).toHaveBeenCalledTimes(2);
  expect(fixture.siblingStart).toHaveBeenCalledOnce();
  expect(fixture.siblingStop).not.toHaveBeenCalled();
}

export async function verifyFailedRecoveryCleanup(createFixture: RecoveryFixtureFactory) {
  const resources: Array<{ closed: boolean }> = [];
  const fixture = await createFixture({
    abortOnCandidateStart: false,
    candidateStart() {
      throw new Error("candidate startup refused");
    },
    prepareAttached: async () => {
      if (resources.length === 3) {
        throw new Error("recovery attachment refused");
      }
    },
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
      const resource = { closed: false };
      resources.push(resource);
      assert(api.lifecycle.onDispose);
      api.lifecycle.onDispose(() => {
        resource.closed = true;
      });
    },
  });

  await expect(fixture.reload()).rejects.toThrow("recovery attachment refused");

  expect(resources).toEqual([{ closed: true }, { closed: true }, { closed: true }]);
  expect(fixture.siblingStart).toHaveBeenCalledOnce();
  expect(fixture.siblingStop).not.toHaveBeenCalled();
}

export async function verifySelfConsumerReload(createFixture: RecoveryFixtureFactory) {
  const fixture = await createFixture({ abortOnCandidateStart: false });
  const record = fixture.previousRegistry.plugins.find((plugin) => plugin.id === "first");
  assert(record);
  const instance = getPluginInstance(record);
  assert(instance);
  const consumer = instance.retainConsumer();
  try {
    await expect(consumer.run(() => fixture.reload())).rejects.toMatchObject({
      details: { phase: "prepare", committed: false },
    });
    expect(fixture.firstStop).not.toHaveBeenCalled();
    expect(fixture.siblingStop).not.toHaveBeenCalled();
    expect(fixture.candidates).toHaveLength(0);
    expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
    expect(instance.run(() => "still serving")).toBe("still serving");
  } finally {
    consumer.release();
  }
}
