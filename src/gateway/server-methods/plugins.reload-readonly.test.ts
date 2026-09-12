import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { resolvePluginArtifactDeclaredSurface } from "../../plugins/capability-artifact.js";
import { resolvePluginCapabilityConsent } from "../../plugins/capability-consent.js";
import { computeDeclaredSurfaceHash } from "../../plugins/capability-summary.js";
import {
  readPersistedInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../../plugins/installed-plugin-index-records.js";
import type { PluginLifecycleRuntimeApply } from "../../plugins/lifecycle.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { pluginMutationHandlers } from "./plugins-mutations.js";

const readOnlyModes = ["OPENCLAW_CONFIG_READONLY", "OPENCLAW_NIX_MODE"] as const;

it.each([
  ...readOnlyModes.flatMap((mode) =>
    (["discovered", "accepted", "consent write"] as const).map((kind) => ({
      mode,
      kind,
      method: "plugins.reload" as const,
    })),
  ),
  ...[undefined, ...readOnlyModes].map((mode) => ({
    mode,
    kind: "accepted" as const,
    method: "plugins.refresh" as const,
  })),
])("$method preserves root include config under $mode ($kind)", async ({ mode, kind, method }) => {
  const reload = method === "plugins.reload";
  await withOpenClawTestState(
    {
      label: "readonly-plugin-reload",
      env: { OPENCLAW_CONFIG_READONLY: undefined, OPENCLAW_NIX_MODE: undefined },
    },
    async (state) => {
      const pluginId = "readonly-reload";
      const rootDir = state.path("plugin");
      await fs.mkdir(rootDir);
      createColdPluginFixture({
        rootDir,
        pluginId,
        manifest: {
          providers: [],
          channels: [],
          channelConfigs: {},
          providerAuthChoices: [],
          contracts: { tools: ["proof.read"] },
        },
      });
      const config = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        plugins: { allow: [pluginId], load: { paths: [rootDir] } },
      };
      // A read-only root include is a supported runtime config, even though install writes cannot own it.
      const includedPath = state.statePath("deployment.json");
      await fs.writeFile(includedPath, JSON.stringify(config));
      await state.writeConfig({ $include: includedPath });
      const reviewToken = computeDeclaredSurfaceHash(
        resolvePluginArtifactDeclaredSurface(rootDir, state.env, { config }),
      );
      if (kind !== "discovered") {
        await writePersistedInstalledPluginIndexInstallRecords(
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
      const configBefore = await fs.readFile(state.configPath, "utf8");
      const includeBefore = await fs.readFile(includedPath, "utf8");
      const recordsBefore = readPersistedInstalledPluginIndexInstallRecords({ env: state.env });
      const applyRuntime = vi.fn<PluginLifecycleRuntimeApply>(async (request) => {
        request.assertInvokerOwned?.();
        expect(request.reason).toBe(reload ? "reload" : "metadata");
        expect(request.pluginIds).toEqual(reload ? [pluginId] : []);
        expect(request.write).toBeUndefined();
        expect(request.config.plugins).toEqual(config.plugins);
        return { operationId: "readonly-reload", generation: 2, pluginIds: [pluginId] };
      });
      const respond = vi.fn();
      const params = reload
        ? {
            plugins: [{ pluginId }],
            ...(kind === "consent write" ? { acknowledgeCapabilities: { reviewToken } } : {}),
          }
        : {};
      await withEnvAsync(mode ? { [mode]: "1" } : {}, async () => {
        await expectDefined(
          pluginMutationHandlers[method],
          "plugin lifecycle handler",
        )({
          req: { type: "req", id: "readonly-reload", method, params },
          params,
          client: null,
          isWebchatConnect: () => false,
          context: createDirectChatContext({
            getRuntimeConfig: () => config,
            applyPluginLifecycleChange: applyRuntime,
          }),
          respond,
        });
      });
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
            runtime: { operationId: "readonly-reload", generation: 2, pluginIds: [pluginId] },
          }),
          undefined,
        );
        expect(applyRuntime).toHaveBeenCalledOnce();
      }
      expect(await fs.readFile(state.configPath, "utf8")).toBe(configBefore);
      expect(await fs.readFile(includedPath, "utf8")).toBe(includeBefore);
      expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(
        recordsBefore,
      );
    },
  );
});
