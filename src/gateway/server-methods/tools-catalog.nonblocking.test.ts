import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolsCatalogResult } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { loadAndActivateRootPluginRegistry } from "../../plugins/loader.js";
import {
  resetPluginLoaderTestStateForTest,
  cleanupPluginLoaderFixturesForTest,
} from "../../plugins/loader.test-fixtures.js";
import * as manifestEligibility from "../../plugins/manifest-contract-eligibility.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { markPluginRegistryRetired } from "../../plugins/registry-lifecycle.js";
import { clearActivePluginRegistry, createPluginRegistryOwner } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import * as loadContextResolver from "../../plugins/runtime/load-context.resolve.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { toolsCatalogHandlers } from "./tools-catalog.js";

const probeKey = "__openclaw_catalog_nonblocking_probe";

afterEach(async () => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, probeKey);
  await clearActivePluginRegistry();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  cleanupPluginLoaderFixturesForTest();
});

it.each(["success", "retired", "failed"] as const)(
  "keeps catalog discovery responsive and releases optional registrations (mode=%s)",
  async (mode) => {
    await withOpenClawTestState(
      {
        prefix: "openclaw-catalog-nonblocking-",
        layout: "split",
        prepareProfileCatalog: true,
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      },
      async (state) => {
        const probe = {
          progressed: false,
          registrations: 0,
          disposals: 0,
          workspaces: [] as string[],
          retire: () => {},
          failRegistration: mode === "failed",
        };
        Object.assign(globalThis, { [probeKey]: probe });
        const files: string[] = [];
        for (const id of ["catalog-alpha", "catalog-beta"]) {
          files.push(
            await state.writeText(
              `plugins/${id}/index.cjs`,
              `module.exports = {
  id: "${id}", register(api) {
    const probe = globalThis["${probeKey}"];
    probe.registrations++;
    api.lifecycle.registerRuntimeLifecycle({ id: "catalog", dispose() { probe.disposals++; } });
    if (probe.registrations === 2) probe.retire();
    if (probe.failRegistration && "${id}" === "catalog-beta") throw new Error("synthetic registration failure");
    api.registerTool((ctx) => { probe.workspaces.push(ctx.workspaceDir); return ({ name: "${id}", label: "${id}", description: "Optional catalog fixture",
      parameters: { type: "object", properties: {} }, async execute() { throw new Error("Catalog must not execute tools"); }
    }); }, { name: "${id}", optional: true });
    api.registerTool(() => null, { name: "${id}_configured", optional: true });
  }
};`,
            ),
          );
          await state.writeJson(`plugins/${id}/openclaw.plugin.json`, {
            id,
            contracts: { tools: [id, `${id}_configured`] },
            configSchema: { type: "object", properties: {}, additionalProperties: false },
          });
        }
        const config: OpenClawConfig = {
          agents: {
            defaults: { workspace: state.workspaceDir },
            entries: { main: {}, other: { workspace: state.path("other-workspace") } },
          },
          plugins: {
            allow: ["catalog-alpha", "catalog-beta"],
            load: { paths: files },
            slots: { memory: "none" },
          },
        };
        const metadataContext = { config, env: process.env, workspaceDir: state.workspaceDir };
        const metadataSnapshot = resolvePluginMetadataSnapshot(metadataContext);
        setGatewayPluginMetadataSnapshot(metadataSnapshot, metadataContext);
        const root = await loadAndActivateRootPluginRegistry({
          ...metadataContext,
          metadataSnapshot,
          onlyPluginIds: [],
        });
        const owner = createPluginRegistryOwner(root, state.workspaceDir);
        const contextPreparation = vi.spyOn(loadContextResolver, "resolvePluginRuntimeLoadContext");
        const manifestPreparation = vi.spyOn(manifestEligibility, "loadManifestContractSnapshot");
        const respond = vi.fn();
        const handler = expectDefined(toolsCatalogHandlers["tools.catalog"], "catalog handler");
        if (mode === "retired") {
          probe.retire = () => markPluginRegistryRetired(root);
        }
        const progress = new Promise<void>((resolve) => {
          setImmediate(() => {
            probe.progressed = true;
            resolve();
          });
        });
        try {
          const invocation = withPluginRuntimeRegistryScope(owner.registry, () =>
            handler({
              params: { agentId: "other" },
              respond,
              context: { getRuntimeConfig: () => config } as never,
              client: null,
              req: { type: "req", id: "catalog", method: "tools.catalog" },
              isWebchatConnect: () => false,
            }),
          );
          if (mode === "retired") {
            await expect(invocation).rejects.toThrow(
              "Plugin catalog generation is no longer available",
            );
            expect(respond).not.toHaveBeenCalled();
            expect(probe).toMatchObject({ registrations: 2, disposals: 2, workspaces: [] });
            return;
          }
          await invocation;
          expect(probe.progressed).toBe(true);
          expect(contextPreparation).not.toHaveBeenCalled();
          expect(manifestPreparation).not.toHaveBeenCalled();
          expect(probe).toMatchObject({ registrations: 2, disposals: 2 });
          expect(respond).toHaveBeenCalledOnce();
          const result = respond.mock.calls[0]?.[1] as ToolsCatalogResult;
          expect(
            result.groups
              .filter((group) => group.source === "plugin")
              .flatMap((group) => group.tools.map((tool) => [tool.id, tool.optional])),
          ).toEqual([
            ["catalog-alpha", true],
            ["catalog-alpha_configured", true],
            ...(mode === "failed"
              ? []
              : [
                  ["catalog-beta", true],
                  ["catalog-beta_configured", true],
                ]),
          ]);
          expect(probe.workspaces).toEqual(
            mode === "failed"
              ? [state.path("other-workspace")]
              : [state.path("other-workspace"), state.path("other-workspace")],
          );
          expect(owner.registry).toBe(root);
          expect(root.tools).toHaveLength(0);
        } finally {
          await progress;
          await owner.close();
        }
      },
    );
  },
);
