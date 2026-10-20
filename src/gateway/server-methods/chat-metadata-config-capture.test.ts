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
      profiles: Object.fromEntries(
        ["before", "after"].map((profile) => [
          `capture-fixture:${profile}`,
          { type: "api_key" as const, provider: "capture-fixture", key: "synthetic" },
        ]),
      ),
    });
    const sessionEntry = (profile: string) => ({
      authProfileOverride: "capture-fixture:" + profile,
      authProfileOverrideSource: "user" as const,
    });
    const project = vi.spyOn(sourceProjection, "projectRuntimeChangesOntoSource");
    try {
      await harness.runtime.refresh();
      const read = async (profile: string) => {
        project.mockClear();
        supports.mockClear();
        const result = await harness.read({ sessionEntry: sessionEntry(profile) });
        expect(result.models?.map(({ id }) => id).toSorted()).toEqual(
          models.map(({ id }) => id).toSorted(),
        );
        return result;
      };
      const before = await read("before");
      expect(supports).toHaveBeenCalled();
      const reloaded = structuredClone(config);
      setRuntimeConfigSnapshot(reloaded, reloaded);
      harness.setConfig(reloaded);
      await harness.runtime.refresh();
      const after = await read("after");
      expect(supports).toHaveBeenCalled();
      expect(project.mock.calls.length).toBeLessThanOrEqual(1);
      expect(after.models).toEqual(before.models);
      expect(after.accountSelection).toMatchObject({
        authProfileId: "capture-fixture:after",
      });
      const retained = await read("after");
      expect(project).not.toHaveBeenCalled();
      expect(retained).toEqual(after);
      const readyParams = {
        agentId: "main",
        readPolicy: "ready" as const,
        sessionEntry: sessionEntry("after"),
      };
      await harness.read();
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
