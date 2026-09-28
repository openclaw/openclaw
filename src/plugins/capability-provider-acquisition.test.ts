import { afterEach, expect, it } from "vitest";
import { retainPreparedPluginRegistry } from "../agents/prepared-model-runtime.plugin-lifetime.js";
import { acquirePluginCapabilityProviders } from "./capability-provider-acquisition.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import {
  getPluginRegistryLifetime,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "./registry-lifecycle.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

afterEach(() => resetPluginRuntimeStateForTest());

it.each([{ custody: "borrowed" }, { custody: "owned" }] as const)(
  "retains owned registries and leaves borrowed registries in their host's custody ($custody)",
  async ({ custody }) => {
    const owner = createTestPluginRegistry();
    const registry = owner.registry;
    const record = createPluginRecord({
      id: "custody-captions",
      source: import.meta.url,
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    registry.plugins.push(record);
    owner.createApi(record, { config: {} }).registerTranscriptSourceProvider({
      id: record.id,
      name: "Custody captions",
      sourceKinds: ["live-caption"],
      async start({ session }) {
        return { ok: true, session: { ...session, title: "Captured by the plugin" } };
      },
    });
    const instance = getPluginInstance(record)!;
    let releaseRegistry: (() => void | Promise<void>) | undefined;
    try {
      if (custody === "borrowed") {
        markPluginRegistryActive(registry);
      } else {
        releaseRegistry = retainPreparedPluginRegistry(registry);
        expect(releaseRegistry).toBeDefined();
      }
      await withPluginRuntimeRegistryScope(registry, async () => {
        const acquired = await acquirePluginCapabilityProviders({
          key: "transcriptSourceProviders",
          providerId: record.id,
          cfg: { plugins: { enabled: true, allow: [record.id] } },
        });
        try {
          expect(acquired.providers).toHaveLength(1);
          const provider = acquired.providers[0]!;
          expect(provider.id).toBe(record.id);
          const session = {
            sessionId: "custody-capture",
            source: { providerId: record.id },
            startedAt: "2026-09-23T00:00:00.000Z",
          };
          await expect(provider.start!({ session, onUtterance() {} })).resolves.toEqual({
            ok: true,
            session: { ...session, title: "Captured by the plugin" },
          });
          expect(() => acquired.assertOpen()).not.toThrow();
          instance.reserveReplacement()();
          if (custody === "owned") {
            expect(instance.retainedWorkCount).toBeGreaterThan(0);
          } else {
            expect(instance.retainedWorkCount).toBe(0);
            expect(provider).toBe(registry.transcriptSourceProviders[0]!.provider);
            expect(getPluginRegistryLifetime(registry)).toBeUndefined();
            markPluginRegistryActive(registry);
            expect(() => acquired.assertOpen()).toThrow(
              "The provider setup changed while preparing this request",
            );
          }
          await acquired.release();
          expect(instance.retainedWorkCount).toBe(0);
        } finally {
          await acquired.release();
        }
      });
    } finally {
      await releaseRegistry?.();
      markPluginRegistryRetired(registry);
      if (!releaseRegistry) {
        await instance.dispose();
      }
    }
  },
);
