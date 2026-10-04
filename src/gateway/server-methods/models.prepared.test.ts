import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import * as pluginScope from "../../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readPreparedCatalog,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";
import { buildModelsListResult } from "./models-list-result.js";
import {
  createModelsListTestContext,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";
import { modelsHandlers } from "./models.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

it("serves the published model-list projection and replaces it with its metadata generation", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "model-list-projection-" },
    async (state) => {
      const config: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: { model: "test/first", modelPolicy: { allow: ["test/*"] } },
        },
      };
      const pluginRegistry = createEmptyPluginRegistry();
      const context = createModelsListTestContext({
        pluginRegistry,
        cfg: config,
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        catalog: [providerCatalogEntry("test", "first")],
      });
      const params = { agentId: "main", view: "all" as const };
      const expected = await buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: "main",
        params,
      });
      const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
      let current = true;
      const owner = {
        ...createChatMetadataOwner(config, "first", {}, "test", "openai-completions"),
        isCurrent: () => current,
        pluginRegistry,
      };
      harness.setOwner(owner);
      context.readPreparedModelsList = harness.runtime.readModelsList;
      const snapshot = (await readPreparedCatalog(context, "main"))!;
      const unpreparedRead = vi.fn(async () => snapshot);
      registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
        readPrepared: unpreparedRead,
        loadDeferred: unpreparedRead,
      });
      const read = async () => {
        let result: unknown;
        await modelsHandlers["models.list"]!({
          req: { type: "req", id: "prepared", method: "models.list", params },
          params,
          context,
          client: null,
          isWebchatConnect: () => false,
          respond: (ok, value, error) => {
            if (!ok) {
              throw new Error(JSON.stringify(error));
            }
            result = value;
          },
        } satisfies GatewayRequestHandlerOptions);
        return result;
      };
      try {
        await harness.runtime.refresh();
        expect(JSON.stringify(await read())).toBe(JSON.stringify(expected));
        const enterPluginScope = vi.spyOn(pluginScope, "withPluginRuntimeRegistryScope");
        const prepareStatement = vi.spyOn(DatabaseSync.prototype, "prepare");
        const executeStatement = vi.spyOn(DatabaseSync.prototype, "exec");
        try {
          expect(await Promise.all(Array.from({ length: 10 }, read))).toEqual(
            Array.from({ length: 10 }, () => expected),
          );
          expect(enterPluginScope).not.toHaveBeenCalled();
          expect(prepareStatement).not.toHaveBeenCalled();
          expect(executeStatement).not.toHaveBeenCalled();
          expect(unpreparedRead).not.toHaveBeenCalled();
        } finally {
          enterPluginScope.mockRestore();
          prepareStatement.mockRestore();
          executeStatement.mockRestore();
        }
        owner.modelCatalog.pendingProviders = ["test"];
        expect(await read()).toMatchObject({ pendingProviders: ["test"] });
        owner.modelCatalog.pendingProviders = undefined;
        owner.modelCatalog.refreshFailed = true;
        expect(await read()).toMatchObject({ refreshFailed: true });
        expect(await read()).not.toHaveProperty("pendingProviders");
        current = false;
        await expect(read()).rejects.toThrow("Model catalog changed while preparing this result");
        const replacement = {
          ...createChatMetadataOwner(config, "second", {}, "test", "openai-completions"),
          pluginRegistry,
        };
        harness.setOwner(replacement);
        await harness.runtime.refresh();
        expect(await read()).toMatchObject({
          models: expect.arrayContaining([expect.objectContaining({ id: "second" })]),
        });
        expect(unpreparedRead).not.toHaveBeenCalled();
      } finally {
        await harness.runtime.stop();
      }
    },
  );
});
