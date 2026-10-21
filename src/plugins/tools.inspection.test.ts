import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOpenClawCodingToolsAsync } from "../agents/agent-tools.js";
import { createAdmittedHostCapabilityTestFixture } from "../agents/harness/host-capability.test-support.js";
import { resolveOpenClawPluginToolsForOptions } from "../agents/openclaw-plugin-tools.js";
import { createOpenClawToolsAsync } from "../agents/openclaw-tools.js";
import { runWithAgentWorkspaceReadiness } from "../agents/workspace-readiness.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationRegistryScope } from "./runtime/generation-state.js";
import { resolvePluginRuntimeLoadContext } from "./runtime/load-context.resolve.js";
import { acquirePluginToolInspectionRegistry } from "./tools.js";
import { readToolTestEvents } from "./tools.test-support.js";
import { resolveRuntimeWebSearchProviders } from "./web-search-providers.runtime.js";

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
});

function writeToolPlugin(params: {
  root: string;
  id: string;
  events: string;
  failure?: "import" | "registration";
  workspaceAccess?: boolean | "execute";
  factoryReadsWorkspace?: boolean;
  webSearchProviderId?: string;
}): string {
  const webSearchProviderId =
    params.webSearchProviderId ?? (params.id === "shared" ? "inspection-search" : undefined);
  fs.mkdirSync(params.root, { recursive: true });
  const writeJson = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(params.root, name), JSON.stringify(value));
  writeJson("package.json", {
    name: params.id,
    version: "1.0.0",
    openclaw: { extensions: ["./index.cjs"] },
  });
  writeJson("openclaw.plugin.json", {
    id: params.id,
    contracts: {
      tools: [`${params.id}_tool`],
      ...(webSearchProviderId ? { webSearchProviders: [webSearchProviderId.trim()] } : {}),
    },
    configSchema: { type: "object", additionalProperties: false },
  });
  fs.writeFileSync(
    path.join(params.root, "index.cjs"),
    `const fs = require("node:fs");
const event = (kind, details = {}) => fs.appendFileSync(${JSON.stringify(params.events)}, JSON.stringify({plugin: ${JSON.stringify(params.id)}, kind, ...details}) + "\\n");
event("import");
if (${params.failure === "import"}) throw new Error("excluded plugin was imported");
module.exports = { id: ${JSON.stringify(params.id)}, register(api) {
  event("register", { mode: api.registrationMode });
  api.lifecycle.onDispose(() => event("dispose"));
  if (${params.failure === "registration"}) throw new Error("fixture admission failed");
  if (${webSearchProviderId !== undefined}) {
    api.registerWebSearchProvider({
      id: ${JSON.stringify(webSearchProviderId)}, label: "Inspection search", hint: "Synthetic search",
      envVars: [], placeholder: "", signupUrl: "https://example.com", credentialPath: "",
      getCredentialValue() {}, setCredentialValue() {},
      createTool() { throw new Error("Inspection must not execute search providers"); }
    });
  }
  api.registerTool((context) => {
    const details = { agentId: context.agentId, workspaceDir: context.workspaceDir };
    event("factory", details);
    if (${params.factoryReadsWorkspace === true}) details.contents = fs.readFileSync(context.workspaceDir + "/input.txt", "utf8");
    return {
      name: ${JSON.stringify(`${params.id}_tool`)}, label: "Inspection fixture", description: "Synthetic inspection fixture",
      parameters: { type: "object", properties: {} },
      execute: async () => { event("execute"); return { content: [{ type: "text", text: JSON.stringify(details) }], details }; },
    };
  }, { name: ${JSON.stringify(`${params.id}_tool`)}, ...${JSON.stringify(params.workspaceAccess === undefined ? {} : { workspaceAccess: params.workspaceAccess })} });
} };
`,
  );
  return params.root;
}

type ToolEvent = {
  plugin: string;
  kind: string;
  mode?: string;
  agentId?: string;
  workspaceDir?: string;
};

function readEvents(file: string, kind?: string): ToolEvent[] {
  return readToolTestEvents<ToolEvent>(file).filter(
    (event) => kind === undefined || event.kind === kind,
  );
}

async function withInspectionState(run: (state: OpenClawTestState) => Promise<void>) {
  await withOpenClawTestState({ env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } }, async (state) => {
    const cache = createPluginCache();
    try {
      await withPluginCache(cache, () => run(state));
    } finally {
      await cache[Symbol.asyncDispose]();
    }
  });
}

function pluginConfig(paths: string[], allow: string[]): OpenClawConfig["plugins"] {
  return { allow, load: { paths }, slots: { memory: "none" } };
}

it.each(
  ([undefined, true, false, "execute"] as const).flatMap((workspaceAccess) =>
    [false, true].map((pluginOnly) => ({ workspaceAccess, pluginOnly })),
  ),
)(
  "honors workspaceAccess=$workspaceAccess with pluginOnly=$pluginOnly before factory and execution",
  async ({ workspaceAccess, pluginOnly }) => {
    await withInspectionState(async (state) => {
      const events = state.path("readiness-events.jsonl");
      const factoryReadsWorkspace = workspaceAccess === undefined || workspaceAccess === true;
      const pluginPath = writeToolPlugin({
        root: state.path("reader-plugin"),
        id: "project",
        events,
        workspaceAccess,
        factoryReadsWorkspace,
      });
      const config: OpenClawConfig = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        plugins: pluginConfig([pluginPath], ["project"]),
      };
      const ready = createDeferred();
      const waiting = createDeferred();
      let complete = false;
      const releaseWorkspace = async (
        pending: PromiseLike<unknown>,
        phase: "factory" | "execute",
      ) => {
        await Promise.race([waiting.promise, pending]);
        expect(readEvents(events, phase)).toEqual([]);
        if (phase === "factory") {
          fs.writeFileSync(path.join(state.workspaceDir, "input.txt"), "late workspace content");
        }
        complete = true;
        ready.resolve();
      };
      const sessionKey = "agent:main:readiness";
      const scope = {
        context: { config, agentId: "main", workspaceDir: state.workspaceDir },
        toolAllowlist: ["project_tool"],
      };
      const loadContext = resolvePluginRuntimeLoadContext({ config, env: process.env });
      const inspection = await acquirePluginToolInspectionRegistry({
        loadContext,
        scopes: [scope],
      });
      let host: Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>> | undefined;
      try {
        await runWithAgentWorkspaceReadiness(
          {
            sessionKey,
            isReady: () => complete,
            assertCurrent: () => {},
            waitUntilReady: () => {
              waiting.resolve();
              return ready.promise;
            },
          },
          async () => {
            host = await createAdmittedHostCapabilityTestFixture({
              runId: "plugin-readiness",
              sessionKey,
              sessionId: "readiness",
              config,
            });
            const pending = withPluginRuntimeRegistryScope(inspection.registry, () =>
              pluginOnly
                ? createOpenClawCodingToolsAsync({
                    config,
                    workspaceDir: state.workspaceDir,
                    sessionKey,
                    agentId: "main",
                    includeCoreTools: false,
                    runtimeToolAllowlist: ["project_tool"],
                    wrapBeforeToolCallHook: false,
                  })
                : createOpenClawToolsAsync({
                    config,
                    workspaceDir: state.workspaceDir,
                    agentDir: state.agentDir(),
                    agentSessionKey: sessionKey,
                    requesterAgentIdOverride: "main",
                    pluginToolAllowlist: ["project_tool"],
                    disableMessageTool: true,
                    webSearchEnabled: false,
                  }),
            );
            if (factoryReadsWorkspace) {
              await releaseWorkspace(pending, "factory");
            }
            const tool = (await pending).find((candidate) => candidate.name === "project_tool");
            assert(tool, "registered project tool remains available");
            const [bound] = host!.hostCapabilities.bindToolSurface([tool]);
            const result = bound!.execute("read", {});
            if (workspaceAccess === "execute") {
              await releaseWorkspace(result, "execute");
            }
            if (workspaceAccess === false) {
              await Promise.race([waiting.promise, result]);
              expect(readEvents(events, "execute").length).toBeGreaterThan(0);
            }
            const output = await result;
            if (factoryReadsWorkspace) {
              expect(output.details).toMatchObject({ contents: "late workspace content" });
            }
            if (workspaceAccess === false) {
              expect(complete).toBe(false);
            }
          },
        );
      } finally {
        ready.resolve();
        host?.closeHost();
        host?.closeAdmission();
        await inspection.release();
      }
    });
  },
);

it("registers the selected fleet once, preserves agent factories, and settles failed owners", async () => {
  await withInspectionState(async (state) => {
    const events = state.path("tool-events.jsonl");
    const ids = ["shared", "worker", "broken", "excluded"];
    const paths = ids.map((id) =>
      writeToolPlugin({
        root: state.path("plugins", id),
        id,
        events,
        ...(id === "broken" ? { failure: "registration" as const } : {}),
        ...(id === "excluded" ? { failure: "import" as const } : {}),
      }),
    );
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "alpha" } },
        entries: {
          alpha: { workspace: state.path("alpha") },
          beta: { workspace: state.path("beta") },
        },
      },
      plugins: pluginConfig(paths, ids),
    };
    const scopes = ["alpha", "beta"].map((agentId) => ({
      context: {
        config,
        agentId,
        agentDir: state.agentDir(agentId),
        workspaceDir: state.path(agentId),
      },
      toolAllowlist: ["shared_tool", "broken_tool", ...(agentId === "beta" ? ["worker_tool"] : [])],
    }));
    const loadContext = resolvePluginRuntimeLoadContext({ config, env: process.env });
    const inspection = await acquirePluginToolInspectionRegistry({ loadContext, scopes });
    try {
      expect(inspection.registry?.diagnostics).toContainEqual(
        expect.objectContaining({
          pluginId: "broken",
          level: "error",
          message: expect.stringContaining("fixture admission failed"),
        }),
      );
      const resolve = (scope: (typeof scopes)[number]) =>
        withPluginRuntimeRegistryScope(inspection.registry, () =>
          resolveOpenClawPluginToolsForOptions({
            options: {
              config,
              requesterAgentIdOverride: scope.context.agentId,
              agentDir: scope.context.agentDir,
              workspaceDir: scope.context.workspaceDir,
              pluginToolAllowlist: scope.toolAllowlist,
            },
            resolvedConfig: config,
          }),
        );
      const alphaTools = resolve(scopes[0]!);
      const betaTools = resolve(scopes[1]!);
      const registry = inspection.registry;
      assert(registry, "Expected the selected inspection registry");
      const resolveProviders = () =>
        resolveRuntimeWebSearchProviders({
          config,
          onlyPluginIds: ["shared"],
          manifestRecords: loadContext.manifestRegistry?.plugins,
        });
      const resolveSearch = (generation: boolean) =>
        withPluginRuntimeRegistryScope(inspection.registry, () =>
          generation
            ? withPluginRuntimeGenerationRegistryScope(registry, resolveProviders)
            : resolveProviders(),
        );
      for (const generation of [false, true]) {
        expect(resolveSearch(generation).map((provider) => provider.id)).toEqual([
          "inspection-search",
        ]);
      }
      expect(alphaTools.map((tool) => tool.name)).toEqual(["shared_tool"]);
      expect(betaTools.map((tool) => tool.name).toSorted()).toEqual(["shared_tool", "worker_tool"]);
      for (const [scope, tools] of [
        [scopes[0]!, alphaTools],
        [scopes[1]!, betaTools],
      ] as const) {
        const shared = tools.find((tool) => tool.name === "shared_tool")!;
        expect((await shared.execute("inspection", {})).details).toEqual({
          agentId: scope.context.agentId,
          workspaceDir: scope.context.workspaceDir,
        });
      }
      expect(
        readEvents(events, "register").toSorted((a, b) => a.plugin.localeCompare(b.plugin)),
      ).toEqual(
        ["broken", "shared", "worker"].map((plugin) => ({
          plugin,
          kind: "register",
          mode: "tool-discovery",
        })),
      );
      expect(readEvents(events).some((event) => event.plugin === "excluded")).toBe(false);
      const factoryEvent = (plugin: string, agentId: string) => ({
        plugin,
        kind: "factory",
        agentId,
        workspaceDir: state.path(agentId),
      });
      expect(readEvents(events, "factory")).toEqual([
        factoryEvent("shared", "alpha"),
        factoryEvent("shared", "beta"),
        factoryEvent("worker", "beta"),
      ]);
      await inspection.release();
      await inspection.release();
      expect(
        readEvents(events, "dispose")
          .map((event) => event.plugin)
          .toSorted(),
      ).toEqual(["broken", "shared", "worker"]);
      expect(() => resolve(scopes[0]!)).toThrow("Plugin tool inspection has been released");
      for (const generation of [false, true]) {
        expect(() => resolveSearch(generation)).toThrow("Plugin tool inspection has been released");
      }
    } finally {
      await inspection.release();
    }
  });
});

it("refuses a selected workspace source outside the prepared inspection inventory", async () => {
  await withInspectionState(async (state) => {
    const events = state.path("tool-events.jsonl");
    const configFor = (label: string): OpenClawConfig => ({
      plugins: pluginConfig(
        [writeToolPlugin({ root: state.path(label), id: "shared", events })],
        ["shared"],
      ),
    });
    const config = configFor("original");
    const other = configFor("replacement");
    const loadContext = resolvePluginRuntimeLoadContext({ config, env: process.env });
    await expect(
      acquirePluginToolInspectionRegistry({
        loadContext,
        scopes: [{ context: { config: other, workspaceDir: state.workspaceDir } }],
      }),
    ).rejects.toThrow("conflicting source ownership for shared");
    expect(readEvents(events)).toEqual([]);
  });
});

it.each(["a-first", "z-second"])(
  "deduplicates identical provider ids across inspected and supplemental owners (%s inspected)",
  async (selected) => {
    await withInspectionState(async (state) => {
      const events = state.path("duplicate-provider-events.jsonl");
      const ids = ["a-first", "z-second"];
      const providerId = " inspection-search ";
      const paths = ids.map((id) =>
        writeToolPlugin({
          root: state.path("plugins", id),
          id,
          events,
          webSearchProviderId: providerId,
        }),
      );
      const config: OpenClawConfig = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        plugins: pluginConfig(paths, ids),
      };
      const loadContext = resolvePluginRuntimeLoadContext({ config, env: process.env });
      expect(loadContext.manifestRegistry?.plugins.map((record) => record.id)).toEqual(ids);
      const inspection = await acquirePluginToolInspectionRegistry({
        loadContext,
        scopes: [
          {
            context: { config, agentId: "main", workspaceDir: state.workspaceDir },
            toolAllowlist: [`${selected}_tool`],
          },
        ],
      });
      try {
        const registry = inspection.registry;
        assert(registry, "Expected the selected inspection registry");
        expect(registry.webSearchProviders.map(({ provider }) => provider.id)).toEqual([
          providerId,
        ]);
        const providers = withPluginRuntimeRegistryScope(registry, () =>
          resolveRuntimeWebSearchProviders({
            config,
            onlyPluginIds: ids,
            manifestRecords: loadContext.manifestRegistry?.plugins,
          }),
        );
        expect(providers.map(({ pluginId, id }) => ({ pluginId, id }))).toEqual([
          { pluginId: "a-first", id: providerId },
        ]);
        expect(
          readEvents(events, "register")
            .map(({ plugin }) => plugin)
            .toSorted(),
        ).toEqual(ids);
      } finally {
        await inspection.release();
      }
    });
  },
);
