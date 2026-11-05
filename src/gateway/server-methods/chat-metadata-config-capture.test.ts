import { expect, test, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { copyPreparedModelRuntimeAuthBindings } from "../../agents/prepared-model-runtime-auth.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as sourceProjection from "../../config/source-value-projection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";

// Exercise the metadata runtime and its real model-list/projector composition. Only
// published inventory, credentials, and the plugin's external support answer are fixtures.
test.each([1, 32])(
  "bounds source projection work for %i metadata models after neutral reload",
  async (count) => {
    const models: ModelCatalogEntry[] = Array.from({ length: count }, (_, index) => ({
      provider: "capture-fixture",
      id: "model-" + index,
      name: "Model " + index,
      api: "openai-completions",
    }));
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "capture-fixture/model-0" },
          models: Object.fromEntries(
            models.map(({ id }) => [
              "capture-fixture/" + id,
              { agentRuntime: { id: "capture-harness" } },
            ]),
          ),
        },
        entries: { main: {} },
      },
      gateway: { port: 18888 },
      models: {
        mode: "replace",
        providers: {
          "capture-fixture": {
            api: "openai-completions",
            baseUrl: "https://fixture.invalid/v1",
            models: [],
          },
        },
      },
    };
    // Making an existing resolved default explicit changes source, not runtime policy.
    setRuntimeConfigSnapshot(config, { ...config, gateway: {} });
    const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
    const template = createChatMetadataOwner(
      config,
      "model-0",
      {},
      "capture-fixture",
      "openai-completions",
    );
    let current = true;
    const registry = createEmptyPluginRegistry();
    const supports = vi.fn(() => ({ supported: true as const }));
    registry.agentHarnesses.push({
      pluginId: "capture-harness",
      source: "fixture",
      harness: {
        id: "capture-harness",
        label: "Capture fixture",
        supports,
        async runAttempt() {
          throw new Error("Metadata must not execute a model");
        },
      },
    });
    const owner = {
      ...template,
      modelCatalog: { entries: models, routeVariants: models },
      isCurrent: () => current,
      pluginRegistry: registry,
    };
    copyPreparedModelRuntimeAuthBindings(template, owner);
    harness.setOwner(owner);
    harness.setAuthStore({
      version: 1,
      profiles: {
        "capture-fixture:before": {
          type: "api_key",
          provider: "capture-fixture",
          key: "synthetic",
        },
        "capture-fixture:after": { type: "api_key", provider: "capture-fixture", key: "synthetic" },
      },
    });
    const project = vi.spyOn(sourceProjection, "projectRuntimeChangesOntoSource");
    try {
      await harness.runtime.refresh();
      const read = async (profile: string) => {
        project.mockClear();
        supports.mockClear();
        const started = performance.now();
        const result = await harness.runtime.read({
          agentId: "main",
          sessionEntry: {
            authProfileOverride: "capture-fixture:" + profile,
            authProfileOverrideSource: "user",
          },
        });
        expect(result.models?.map(({ id }) => id).toSorted()).toEqual(
          models.map(({ id }) => id).toSorted(),
        );
        const stats = {
          count,
          profile,
          projections: project.mock.calls.length,
          supports: supports.mock.calls.length,
          ms: performance.now() - started,
        };
        console.log(JSON.stringify(stats));
        return { ...stats, result };
      };
      const before = await read("before");
      expect(before.supports).toBeGreaterThan(0);
      const reloaded = structuredClone(config);
      setRuntimeConfigSnapshot(reloaded, reloaded);
      harness.setConfig(reloaded);
      await harness.runtime.refresh();
      const after = await read("after");
      expect(after.supports).toBeGreaterThan(0);
      expect(after.projections).toBeLessThanOrEqual(1);
      expect(after.result.models).toEqual(before.result.models);
      expect(after.result.accountSelection).toMatchObject({
        authProfileId: "capture-fixture:after",
      });
      const retained = await read("after");
      expect(retained.projections).toBe(0);
      expect(retained.result).toEqual(after.result);
      const readyParams = {
        agentId: "main",
        readPolicy: "ready" as const,
        sessionEntry: {
          authProfileOverride: "capture-fixture:after",
          authProfileOverrideSource: "user" as const,
        },
      };
      await harness.runtime.read({ agentId: "main" });
      expect(await harness.runtime.readStartup(readyParams)).toBeDefined();
      current = false;
      await expect(harness.runtime.readStartup(readyParams)).resolves.toBeUndefined();
    } finally {
      await harness.runtime.stop();
      project.mockRestore();
      clearRuntimeConfigSnapshot();
    }
  },
);
