import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { resolvePluginArtifactDeclaredSurface } from "../../plugins/capability-artifact.js";
import { resolvePluginCapabilityConsent } from "../../plugins/capability-consent.js";
import { computeDeclaredSurfaceHash } from "../../plugins/capability-summary.js";
import type { PluginLifecycleRuntimeApply } from "../../plugins/lifecycle.js";
import { seedInstalledPluginIndex } from "../../plugins/test-helpers/installed-plugin-index.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { pluginMutationHandlers } from "./plugins-mutations.js";
import { coldPlugin, readPluginState, pluginRequest } from "./plugins.test-support.js";

it.each([
  ["OPENCLAW_CONFIG_READONLY", "discovered", "plugins.reload"],
  ["OPENCLAW_NIX_MODE", "accepted", "plugins.reload"],
  ["OPENCLAW_CONFIG_READONLY", "consent write", "plugins.reload"],
  ["OPENCLAW_NIX_MODE", "consent write", "plugins.reload"],
  [undefined, "accepted", "plugins.refresh"],
  ["OPENCLAW_CONFIG_READONLY", "accepted", "plugins.refresh"],
] as const)("%s (%s) preserves root include config during %s", async (mode, kind, method) => {
  const reload = method === "plugins.reload";
  await withOpenClawTestState(
    {
      label: "readonly-plugin-reload",
      env: { OPENCLAW_CONFIG_READONLY: undefined, OPENCLAW_NIX_MODE: undefined },
    },
    async (state) => {
      const pluginId = "readonly-reload";
      const { rootDir, plugins } = await coldPlugin(state, pluginId, {
        tools: ["proof.read"],
      });
      const config = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        plugins,
      };
      // A read-only root include is a supported runtime config, even though install writes cannot own it.
      const includedPath = await state.writeJson("deployment.json", config);
      await state.writeConfig({ $include: includedPath });
      const reviewToken = computeDeclaredSurfaceHash(
        resolvePluginArtifactDeclaredSurface(rootDir, state.env, { config }),
      );
      if (kind !== "discovered") {
        await seedInstalledPluginIndex(
          { [pluginId]: { source: "path", sourcePath: rootDir, installPath: rootDir } },
          { env: state.env, config },
        );
        if (kind === "accepted") {
          await resolvePluginCapabilityConsent({
            config,
            pluginId,
            env: state.env,
            acknowledge: { reviewToken },
          });
        }
      }
      const before = await readPluginState(state, includedPath);
      const runtime = { operationId: "readonly-reload", generation: 2, pluginIds: [pluginId] };
      const applyRuntime = vi.fn<PluginLifecycleRuntimeApply>(async (request) => {
        request.assertInvokerOwned?.();
        expect(request.reason).toBe(reload ? "reload" : "metadata");
        expect(request.pluginIds).toEqual(reload ? [pluginId] : []);
        expect(request.write).toBeUndefined();
        expect(request.config.plugins).toEqual(config.plugins);
        return runtime;
      });
      const params = reload
        ? {
            plugins: [{ pluginId }],
            ...(kind === "consent write" ? { acknowledgeCapabilities: { reviewToken } } : {}),
          }
        : {};
      const options = pluginRequest(
        method,
        params,
        createDirectChatContext({
          getRuntimeConfig: () => config,
          applyPluginLifecycleChange: applyRuntime,
        }),
      );
      const { respond } = options;
      const handler = expectDefined(pluginMutationHandlers[method], "plugin lifecycle handler");
      await withEnvAsync(mode ? { [mode]: "1" } : {}, () => handler(options));
      if (kind === "consent write") {
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          false,
          undefined,
          expect.objectContaining({ message: expect.stringContaining(`${mode}=1`) }),
        );
        expect(applyRuntime).not.toHaveBeenCalled();
      } else {
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          expect.objectContaining({
            ok: true,
            restartRequired: false,
            ...(reload ? { pluginIds: [pluginId] } : {}),
            runtime,
          }),
          undefined,
        );
        expect(applyRuntime).toHaveBeenCalledOnce();
      }
      expect(await readPluginState(state, includedPath)).toEqual(before);
    },
  );
});
