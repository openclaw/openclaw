import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import * as protocol from "../../../packages/gateway-protocol/src/index.js";
import { listCoreToolFactoryDescriptors } from "../../agents/tool-catalog.js";
import { filterToolsByPolicy } from "../../agents/tool-policy-match.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { loadAndActivateRootPluginRegistry } from "../../plugins/loader.js";
import * as loaderFixtures from "../../plugins/loader.test-fixtures.js";
import * as manifestEligibility from "../../plugins/manifest-contract-eligibility.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { markPluginRegistryRetired } from "../../plugins/registry-lifecycle.js";
import { clearActivePluginRegistry, createPluginRegistryOwner } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import * as loadContextResolver from "../../plugins/runtime/load-context.resolve.js";
import * as pluginTools from "../../plugins/tools.js";
import * as profiles from "../../state/user-profile-list.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { toolsCatalogHandlers } from "./tools-catalog.js";

const probeKey = "__openclaw_catalog_nonblocking_probe";
afterEach(async () => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, probeKey);
  await clearActivePluginRegistry();
  clearPluginMetadataLifecycleCaches();
  loaderFixtures.resetPluginLoaderTestStateForTest();
  loaderFixtures.cleanupPluginLoaderFixturesForTest();
});

it.each(["success", "retired", "failed", "load", "resolve", "cleanup"] as const)(
  "preserves catalog projection, responsiveness and cleanup (%s)",
  async (mode) => {
    await withOpenClawTestState(
      {
        prefix: "openclaw-catalog-",
        layout: "split",
        prepareProfileCatalog: true,
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      },
      async (state) => {
        const probe = {
          progressed: false,
          progressBeforeRegistration: [] as boolean[],
          registrations: 0,
          disposals: 0,
          workspaces: [] as string[],
          retire: () => {},
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
    probe.progressBeforeRegistration.push(probe.progressed);
    probe.registrations++;
    if (probe.registrations === 1) setImmediate(() => { probe.progressed = true; });
    api.lifecycle.registerRuntimeLifecycle({ id: "catalog", dispose() { probe.disposals++; } });
    if (probe.registrations === 2) probe.retire();
    if (${mode === "failed"} && "${id}" === "catalog-beta") throw new Error("synthetic registration failure");
    if ("${id}" === "catalog-alpha") api.registerToolMetadata({ toolName: "${id}", displayName: "Alpha", description: "Owned description", risk: "high", tags: ["fixture"] });
    else api.registerToolMetadata({ toolName: "catalog-alpha", displayName: "Wrong owner" });
    api.registerTool(() => null, { name: "aaa_${id}", optional: true });
    api.registerTool(() => null, { names: ["tts", "catalog-alpha"], optional: true });
    api.registerTool((ctx) => { probe.workspaces.push(ctx.workspaceDir); return Object.freeze({
      name: "${id}", label: "${id}", description: "Fallback description", displaySummary: "Short summary",
      parameters: { type: "object", properties: { destination: { type: "string", description: "Call destination." }, note: { type: "string", description: "Optional note.", default: "hidden" } }, required: ["destination"] },
      async execute() { throw new Error("Catalog must not execute tools"); }
    }); }, { name: "${id}", optional: true });
  }
};`,
            ),
          );
          await state.writeJson(`plugins/${id}/openclaw.plugin.json`, {
            id,
            contracts: { tools: [id, `aaa_${id}`, "tts", "catalog-alpha"] },
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
        const invoke = (params = {}, cfg = config) =>
          withPluginRuntimeRegistryScope(owner.registry, () =>
            handler({
              params,
              respond,
              context: { getRuntimeConfig: () => cfg } as never,
              client: null,
              req: { type: "req", id: "catalog", method: "tools.catalog" },
              isWebchatConnect: () => false,
            }),
          );
        if (mode === "retired") {
          probe.retire = () => markPluginRegistryRetired(root);
        }
        const failure = new Error("synthetic producer failure");
        const originalAcquire = pluginTools.acquireStandalonePluginToolRegistry;
        const acquire = vi.spyOn(pluginTools, "acquireStandalonePluginToolRegistry");
        if (mode === "load") {
          acquire.mockRejectedValueOnce(failure);
        }
        if (mode === "resolve" || mode === "cleanup") {
          acquire.mockImplementationOnce(async (params) => {
            const acquisition = await originalAcquire(params);
            if (mode === "resolve") {
              vi.spyOn(acquisition, "resolveTools").mockImplementation(() => {
                throw failure;
              });
            } else {
              const release = acquisition.release;
              vi.spyOn(acquisition, "release").mockImplementation(async () => {
                await release();
                throw failure;
              });
            }
            return acquisition;
          });
        }
        try {
          const invocation = invoke({ agentId: "other" });
          if (["retired", "load", "resolve", "cleanup"].includes(mode)) {
            await expect(invocation).rejects.toThrow(
              mode === "retired" ? "Plugin catalog generation is no longer available" : failure,
            );
            expect(respond).not.toHaveBeenCalled();
          } else {
            await invocation;
            expect(respond).toHaveBeenCalledOnce();
            const result = respond.mock.calls[0]?.[1] as protocol.ToolsCatalogResult;
            const groups = result.groups.filter((group) => group.source === "plugin");
            expect(groups.map((group) => [group.id, group.tools.map((tool) => tool.id)])).toEqual([
              ["plugin:catalog-alpha", ["aaa_catalog-alpha", "catalog-alpha"]],
              ...(mode === "failed"
                ? []
                : [["plugin:catalog-beta", ["aaa_catalog-beta", "catalog-beta"]]]),
            ]);
            const alpha = groups[0]?.tools.find((tool) => tool.id === "catalog-alpha");
            expect(alpha).toMatchObject({
              label: "Alpha",
              description: "Short summary",
              fullDescription: "Owned description",
              optional: true,
              risk: "high",
              tags: ["fixture"],
              defaultProfiles: [],
            });
            expect(
              alpha?.parameters?.map((p) => [p.name, p.required, p.type, p.description]),
            ).toEqual([
              ["destination", true, "string", "Call destination."],
              ["note", false, "string", "Optional note."],
            ]);
            if (mode === "success") {
              expect(groups[1]?.tools.find((tool) => tool.id === "catalog-beta")).toMatchObject({
                label: "catalog-beta",
                fullDescription: "Fallback description",
                description: "Short summary",
              });
            }
          }
          expect(probe.progressBeforeRegistration).toEqual(mode === "load" ? [] : [false, true]);
          expect(contextPreparation).not.toHaveBeenCalled();
          expect(manifestPreparation).not.toHaveBeenCalled();
          expect(probe.registrations).toBe(mode === "load" ? 0 : 2);
          expect(probe.disposals).toBe(mode === "load" ? 0 : 2);
          const factoryCount =
            mode === "success" || mode === "cleanup" ? 2 : mode === "failed" ? 1 : 0;
          expect(probe.workspaces).toEqual(Array(factoryCount).fill(state.path("other-workspace")));
          expect(root.tools).toHaveLength(0);
          if (mode === "success") {
            for (const [params, message] of [
              [{ extra: true }, "invalid tools.catalog params"],
              [{ agentId: "unknown-agent" }, "unknown agent id"],
            ] as const) {
              respond.mockClear();
              await invoke(params);
              expect(respond.mock.calls[0]?.[0]).toBe(false);
              expect(respond.mock.calls[0]?.[2]).toMatchObject({
                code: protocol.ErrorCodes.INVALID_REQUEST,
                message: expect.stringContaining(message),
              });
            }
            const configurable = listCoreToolFactoryDescriptors().filter(
              (tool) => tool.name !== "structured_output",
            );
            const core = { agentId: "main", includePlugins: false };
            for (const swarm of [false, true]) {
              for (const multipleProfiles of [false, true]) {
                vi.spyOn(profiles, "hasMultipleResidentSessionSharingIdentities").mockReturnValue(
                  multipleProfiles,
                );
                respond.mockClear();
                await invoke(core, { ...config, tools: { swarm } });
                const result = respond.mock.calls[0]?.[1] as protocol.ToolsCatalogResult;
                const tools = result.groups.flatMap((group) => group.tools),
                  ids = tools.map((tool) => tool.id);
                expect(result.agentId).toBe("main");
                expect(tools.filter((tool) => tool.id === "openclaw")).toEqual([
                  expect.objectContaining({ source: "core", defaultProfiles: [] }),
                ]);
                expect(ids.includes("agents_wait")).toBe(swarm);
                expect(ids.includes("personal_instructions")).toBe(multipleProfiles);
                if (swarm && multipleProfiles) {
                  expect(filterToolsByPolicy(configurable, { allow: ["*"], deny: ids })).toEqual(
                    [],
                  );
                }
              }
            }
            expect(probe.registrations).toBe(2);
          }
        } finally {
          await owner.close();
        }
      },
    );
  },
);
