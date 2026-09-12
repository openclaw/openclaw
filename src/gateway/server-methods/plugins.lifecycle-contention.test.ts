import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import type { PluginLifecycleRuntimeApply } from "../../plugins/lifecycle.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createCoreGatewayMethodDescriptors } from "../methods/core-descriptors.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createGatewayActiveWorkTracker } from "../server-reload-active-work.js";
import { nextGatewayReloadGeneration } from "../server-reload-generation.js";
import { pluginMutationHandlers } from "./plugins-mutations.js";

it.each(["direct", "nested"] as const)(
  "rejects %s lifecycle contention before writes so the owning channel reload can finish",
  async (invocation) => {
    await withOpenClawTestState({ label: "plugin-lifecycle-contention" }, async (state) => {
      resetGatewayWorkAdmission();
      const pluginId = "lifecycle-contention";
      const rootDir = state.path("plugin");
      await fs.mkdir(rootDir);
      createColdPluginFixture({
        rootDir,
        pluginId,
        manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
      });
      const config = {
        plugins: {
          allow: [pluginId],
          load: { paths: [rootDir] },
          entries: { [pluginId]: { enabled: true } },
        },
      };
      await state.writeConfig(config);
      const configBefore = await fs.readFile(state.configPath, "utf8");
      const recordsBefore = readPersistedInstalledPluginIndexInstallRecords({ env: state.env });
      const applyRuntime = vi.fn<PluginLifecycleRuntimeApply>(async (change) => {
        change.assertInvokerOwned?.();
        expect(change.config.plugins?.entries?.[pluginId]?.enabled).toBe(false);
        return { operationId: "idle-retry", generation: 2, pluginIds: [pluginId] };
      });
      const context = createDirectChatContext({
        getRuntimeConfig: () => config,
        applyPluginLifecycleChange: applyRuntime,
      });
      const handler = expectDefined(pluginMutationHandlers["plugins.setEnabled"], "enable handler");
      const methodRegistry = createGatewayMethodRegistry(
        createCoreGatewayMethodDescriptors({ "plugins.setEnabled": handler }),
      );
      const dispatch = (signal: AbortSignal) => {
        const respond = vi.fn();
        const run = () =>
          handleGatewayRequest({
            req: {
              type: "req",
              id: "contending-reload",
              method: "plugins.setEnabled",
              params: { pluginId, enabled: false },
            },
            client: null,
            isWebchatConnect: () => false,
            context,
            methodRegistry,
            signal,
            sessionMutationCommitGuard: () => beginDrain.resolve(),
            respond,
          });
        const request =
          invocation === "nested"
            ? runWithGatewayIndependentRootWorkAdmission(run, "agent:plugin-update")
            : run();
        return { request, respond };
      };
      const held = createDeferred();
      const beginDrain = createDeferred();
      let current = true;
      let reloadFinished = false;
      const logReload = { warn: vi.fn(), info: vi.fn() };
      const tracker = createGatewayActiveWorkTracker({
        params: { logReload },
        myGeneration: nextGatewayReloadGeneration(),
      });
      const reload = withPluginLifecycleLease({ env: state.env }, () =>
        runWithGatewayIndependentRootWorkAdmission(async () => {
          held.resolve();
          await beginDrain.promise;
          await tracker.waitForActiveWorkBeforeChannelReload(["discord"], () => current, true);
          reloadFinished = true;
        }, "reload:config"),
      );
      await held.promise;
      const controller = new AbortController();
      const { request, respond } = dispatch(controller.signal);
      try {
        await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce(), { timeout: 1_000 });
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            retryable: true,
            message: expect.stringContaining("retry"),
          }),
        );
        await request;
        expect(applyRuntime).not.toHaveBeenCalled();
        expect(await fs.readFile(state.configPath, "utf8")).toBe(configBefore);
        expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(
          recordsBefore,
        );
        await reload;
        expect(reloadFinished).toBe(true);
        expect(logReload.warn).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("deferring until 1 gateway request(s) complete"),
        );
        expect(getActiveGatewayRootWorkCount()).toBe(0);

        const retry = dispatch(new AbortController().signal);
        await retry.request;
        expect(retry.respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            ok: true,
            runtime: { operationId: "idle-retry", generation: 2, pluginIds: [pluginId] },
          }),
          undefined,
        );
        expect(applyRuntime).toHaveBeenCalledOnce();
        expect(
          JSON.parse(await fs.readFile(state.configPath, "utf8")).plugins.entries[pluginId].enabled,
        ).toBe(false);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        controller.abort();
        current = false;
        beginDrain.resolve();
        await Promise.allSettled([request, reload]);
        resetGatewayWorkAdmission();
      }
    });
  },
);
