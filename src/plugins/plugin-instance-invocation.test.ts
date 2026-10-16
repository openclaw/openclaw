import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getScopedPluginCache,
} from "./plugin-cache.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { createOwnedTestInstance, createTestInstance } from "./plugin-instance.test-support.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import * as gatewayScope from "./runtime/gateway-request-scope.js";
import {
  getPluginRuntimeGatewayRequestScope as getScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "./runtime/generation-scope.js";

afterEach(() => vi.restoreAllMocks());

it("reuses one identity descriptor per instance across repeated invocations", async () => {
  const instances = ["paired-scope", "other-scope"].map((id) => createOwnedTestInstance(id));
  const scopes = vi.spyOn(gatewayScope, "withPluginRuntimePluginScope");
  for (const instance of instances) {
    for (let index = 0; index < 100; index++) {
      instance.run(() => expect(getScope()?.pluginId).toBe(instance.pluginId));
    }
  }
  const identities = scopes.mock.calls.map(([scope]) => scope);
  expect(identities).toHaveLength(200);
  expect(new Set(identities).size).toBe(2);
});

it.each(["ordinary", "consumer"] as const)(
  "admits a %s callback in one independent frame and retains its closure fence",
  async (kind) => {
    const instance = createOwnedTestInstance("paired-scope");
    const consumer = kind === "consumer" ? instance.retainConsumer() : undefined;
    onTestFinished(() => consumer?.release());
    let retained: (() => void) | undefined;
    let outer: ReturnType<typeof getScope>;
    let calls = 0;
    const hook = (consumer ?? instance).wrap((callback: () => void) => {
      outer = getScope();
      retained = callback;
      callback();
      expect(getScope()).toBe(outer);
    });
    const frames = vi.spyOn(AsyncLocalStorage.prototype, "run");
    hook(() => {
      calls++;
      const scope = getScope();
      expect(scope?.pluginId).toBe(instance.pluginId);
      expect(scope).not.toBe(outer);
    });
    expect(frames).toHaveBeenCalledTimes(2);
    frames.mockRestore();
    expect(getScope()).toBeUndefined();
    if (consumer) {
      consumer.release();
      expect(instance.run(() => "still open")).toBe("still open");
    } else {
      await instance.dispose();
    }
    expect(() => retained!()).toThrow(consumer ? "consumer is closed" : "reloaded or disabled");
    expect(calls).toBe(1);
  },
);

it("preserves Gateway and generation context through invocation exit and rejection", async () => {
  const instance = createOwnedTestInstance("paired-scope");
  const unowned = createTestInstance("unowned-scope");
  const parent = { isWebchatConnect: () => false, revalidate: async () => {} };
  const generation = {
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    pluginRegistry: createEmptyPluginRegistry(),
  };
  const cache = createPluginCache();
  bindPluginMetadataSnapshotCache(generation.metadataSnapshot, cache);
  const expectGeneration = () => {
    expect(getCurrentPluginMetadataSnapshot()).toBe(generation.metadataSnapshot);
    expect(getScopedPluginCache()).toBe(cache);
    expect(getPluginRuntimeGenerationRegistry()).toBe(generation.pluginRegistry);
  };
  const expectContext = (
    call: ReturnType<typeof pluginInstanceInvocation.getStore>,
    gateway: ReturnType<typeof getScope>,
  ) => {
    expect(pluginInstanceInvocation.getStore()).toBe(call);
    expect(getScope()).toBe(gateway);
    expectGeneration();
  };
  await withPluginRuntimeGenerationScope(generation, () =>
    withPluginRuntimeGatewayRequestScope(parent, () =>
      instance.run(async () => {
        const call = pluginInstanceInvocation.getStore();
        const gateway = getScope()!;
        expect(call?.instance).toBe(instance);
        expect(gateway.revalidate).toBe(parent.revalidate);
        expectGeneration();
        const explicit = { ...gateway, pluginSource: "explicit-child" };
        await withPluginRuntimeGatewayRequestScope(explicit, async () => {
          await Promise.resolve();
          expectContext(call, explicit);
        });
        expect(getScope()).toBe(gateway);
        const failure = new Error("cleanup fixture");
        await expect(
          pluginInstanceInvocation.exit(async () => {
            expectContext(undefined, gateway);
            await unowned.run(async () => {
              await Promise.resolve();
              expect(pluginInstanceInvocation.getStore()?.instance).toBe(unowned);
              expect(getScope()).toBe(gateway);
              expectGeneration();
            });
            expectContext(undefined, gateway);
            throw failure;
          }),
        ).rejects.toBe(failure);
        expectContext(call, gateway);
      }),
    ),
  );
  expect(pluginInstanceInvocation.getStore()).toBeUndefined();
  expect(getScope()).toBeUndefined();
  expect(getScopedPluginCache()).toBeUndefined();
  expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
});

it("isolates mutable sibling Gateway views when the admitted instance token is unchanged", async () => {
  const instance = createOwnedTestInstance("paired-scope");
  const other = createOwnedTestInstance("other-scope");
  await instance.run(async () => {
    const call = pluginInstanceInvocation.getStore();
    const parent = getScope()!;
    const originalSource = parent.pluginSource;
    const children = await Promise.all(
      ["left", "right"].map((source) =>
        instance.run(async () => {
          const child = getScope()!;
          expect(child).not.toBe(parent);
          expect(pluginInstanceInvocation.getStore()).toBe(call);
          child.pluginSource = source;
          await Promise.resolve();
          expect(getScope()).toBe(child);
          expect(child.pluginSource).toBe(source);
          expect(parent.pluginSource).toBe(originalSource);
          await other.run(async () => {
            await Promise.resolve();
            expect(pluginInstanceInvocation.getStore()?.instance).toBe(other);
            expect(getScope()?.pluginId).toBe(other.pluginId);
            expect(getScope()?.pluginRegistry).not.toBe(child.pluginRegistry);
          });
          expect(pluginInstanceInvocation.getStore()).toBe(call);
          expect(getScope()).toBe(child);
          return child;
        }),
      ),
    );
    expect(children[0]).not.toBe(children[1]);
    expect(pluginInstanceInvocation.getStore()).toBe(call);
    expect(getScope()).toBe(parent);
  });
});

it("shares one invocation facade and Gateway view across same-version module reloads", async () => {
  const instance = createOwnedTestInstance("paired-scope");
  try {
    await instance.run(async () => {
      const call = pluginInstanceInvocation.getStore();
      const gateway = getScope();
      vi.resetModules();
      const duplicateInvocation = await import("./plugin-instance-invocation.js");
      const duplicateGateway = await import("./runtime/gateway-request-scope.js");
      expect(duplicateInvocation.pluginInstanceInvocation).toBe(pluginInstanceInvocation);
      expect(duplicateInvocation.pluginInstanceInvocation.getStore()).toBe(call);
      expect(duplicateGateway.getPluginRuntimeGatewayRequestScope()).toBe(gateway);
    });
  } finally {
    await instance.dispose();
    vi.resetModules();
  }
});
