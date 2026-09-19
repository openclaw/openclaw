import { describe, expect, it, vi } from "vitest";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getScopedPluginCache,
} from "./plugin-cache.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { PluginInstance } from "./plugin-instance.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "./runtime/generation-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

function createOwnedInstance() {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "paired-scope" });
  registry.plugins.push(record);
  return new PluginInstance(record.id, { record, registry });
}

describe("independent plugin execution scope views", () => {
  it("preserves Gateway and generation context through invocation exit and rejection", async () => {
    const instance = createOwnedInstance();
    const unowned = new PluginInstance("unowned-scope");
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
    try {
      await withPluginRuntimeGenerationScope(generation, () =>
        withPluginRuntimeGatewayRequestScope(parent, () =>
          instance.run(async () => {
            const call = pluginInstanceInvocation.getStore();
            const gateway = getPluginRuntimeGatewayRequestScope()!;
            expect(call?.instance).toBe(instance);
            expect(gateway.revalidate).toBe(parent.revalidate);
            expectGeneration();
            const explicit = { ...gateway, pluginSource: "explicit-child" };
            await withPluginRuntimeGatewayRequestScope(explicit, async () => {
              await Promise.resolve();
              expect(getPluginRuntimeGatewayRequestScope()).toBe(explicit);
              expect(pluginInstanceInvocation.getStore()).toBe(call);
              expectGeneration();
            });
            expect(getPluginRuntimeGatewayRequestScope()).toBe(gateway);
            const failure = new Error("cleanup fixture");
            await expect(
              pluginInstanceInvocation.exit(async () => {
                expect(pluginInstanceInvocation.getStore()).toBeUndefined();
                expect(getPluginRuntimeGatewayRequestScope()).toBe(gateway);
                expectGeneration();
                await unowned.run(async () => {
                  await Promise.resolve();
                  expect(pluginInstanceInvocation.getStore()?.instance).toBe(unowned);
                  expect(getPluginRuntimeGatewayRequestScope()).toBe(gateway);
                  expectGeneration();
                });
                expect(pluginInstanceInvocation.getStore()).toBeUndefined();
                expect(getPluginRuntimeGatewayRequestScope()).toBe(gateway);
                throw failure;
              }),
            ).rejects.toBe(failure);
            expect(pluginInstanceInvocation.getStore()).toBe(call);
            expect(getPluginRuntimeGatewayRequestScope()).toBe(gateway);
            expectGeneration();
          }),
        ),
      );
      expect(pluginInstanceInvocation.getStore()).toBeUndefined();
      expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
      expect(getScopedPluginCache()).toBeUndefined();
      expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
    } finally {
      await Promise.all([instance.dispose(), unowned.dispose()]);
    }
  });

  it("isolates mutable sibling Gateway views when the admitted instance token is unchanged", async () => {
    const instance = createOwnedInstance();
    try {
      await instance.run(async () => {
        const call = pluginInstanceInvocation.getStore();
        const parent = getPluginRuntimeGatewayRequestScope()!;
        const originalSource = parent.pluginSource;
        const children = await Promise.all(
          ["left", "right"].map((source) =>
            instance.run(async () => {
              const child = getPluginRuntimeGatewayRequestScope()!;
              expect(child).not.toBe(parent);
              expect(pluginInstanceInvocation.getStore()).toBe(call);
              child.pluginSource = source;
              await Promise.resolve();
              expect(getPluginRuntimeGatewayRequestScope()).toBe(child);
              expect(child.pluginSource).toBe(source);
              expect(parent.pluginSource).toBe(originalSource);
              return child;
            }),
          ),
        );
        expect(children[0]).not.toBe(children[1]);
        expect(pluginInstanceInvocation.getStore()).toBe(call);
        expect(getPluginRuntimeGatewayRequestScope()).toBe(parent);
      });
    } finally {
      await instance.dispose();
    }
  });

  it("shares one invocation facade and Gateway view across same-version module reloads", async () => {
    const instance = createOwnedInstance();
    try {
      await instance.run(async () => {
        const call = pluginInstanceInvocation.getStore();
        const gateway = getPluginRuntimeGatewayRequestScope();
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
});
