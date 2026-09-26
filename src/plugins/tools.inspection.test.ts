import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOpenClawPluginToolsForOptions } from "../agents/openclaw-plugin-tools.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { resolvePluginRuntimeLoadContext } from "./runtime/load-context.resolve.js";
import { acquirePluginToolInspectionRegistry } from "./tools.js";

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
});

function writeToolPlugin(params: {
  root: string;
  id: string;
  events: string;
  failure?: "import" | "registration";
}): string {
  fs.mkdirSync(params.root, { recursive: true });
  fs.writeFileSync(
    path.join(params.root, "package.json"),
    JSON.stringify({
      name: params.id,
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  fs.writeFileSync(
    path.join(params.root, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.id,
      contracts: { tools: [`${params.id}_tool`] },
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
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
  api.registerTool((context) => {
    const details = { agentId: context.agentId, workspaceDir: context.workspaceDir };
    event("factory", details);
    return {
      name: ${JSON.stringify(`${params.id}_tool`)}, label: "Inspection fixture", description: "Synthetic inspection fixture",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: JSON.stringify(details) }], details }),
    };
  }, { name: ${JSON.stringify(`${params.id}_tool`)} });
} };
`,
  );
  return params.root;
}

function readEvents(file: string): Array<{
  plugin: string;
  kind: string;
  mode?: string;
  agentId?: string;
  workspaceDir?: string;
}> {
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}

describe("plugin tool inspection ownership", () => {
  it("registers the selected fleet once, preserves agent factories, and settles failed owners", async () => {
    await withOpenClawTestState(
      { env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
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
          plugins: { allow: ids, load: { paths }, slots: { memory: "none" } },
        };
        const scopes = ["alpha", "beta"].map((agentId) => ({
          context: {
            config,
            agentId,
            agentDir: state.agentDir(agentId),
            workspaceDir: state.path(agentId),
          },
          toolAllowlist: [
            "shared_tool",
            "broken_tool",
            ...(agentId === "beta" ? ["worker_tool"] : []),
          ],
        }));
        const cache = createPluginCache();
        try {
          await withPluginCache(cache, async () => {
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
              expect(alphaTools.map((tool) => tool.name)).toEqual(["shared_tool"]);
              expect(betaTools.map((tool) => tool.name).toSorted()).toEqual([
                "shared_tool",
                "worker_tool",
              ]);
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
              const observed = readEvents(events);
              expect(
                observed
                  .filter((event) => event.kind === "register")
                  .toSorted((a, b) => a.plugin.localeCompare(b.plugin)),
              ).toEqual([
                { plugin: "broken", kind: "register", mode: "tool-discovery" },
                { plugin: "shared", kind: "register", mode: "tool-discovery" },
                { plugin: "worker", kind: "register", mode: "tool-discovery" },
              ]);
              expect(observed.some((event) => event.plugin === "excluded")).toBe(false);
              expect(observed.filter((event) => event.kind === "factory")).toEqual([
                {
                  plugin: "shared",
                  kind: "factory",
                  agentId: "alpha",
                  workspaceDir: state.path("alpha"),
                },
                {
                  plugin: "shared",
                  kind: "factory",
                  agentId: "beta",
                  workspaceDir: state.path("beta"),
                },
                {
                  plugin: "worker",
                  kind: "factory",
                  agentId: "beta",
                  workspaceDir: state.path("beta"),
                },
              ]);
              await inspection.release();
              await inspection.release();
              expect(
                readEvents(events)
                  .filter((event) => event.kind === "dispose")
                  .map((event) => event.plugin)
                  .toSorted(),
              ).toEqual(["broken", "shared", "worker"]);
              expect(() => resolve(scopes[0]!)).toThrow("Plugin tool inspection has been released");
            } finally {
              await inspection.release();
            }
          });
        } finally {
          await cache[Symbol.asyncDispose]();
        }
      },
    );
  });

  it("refuses a selected workspace source outside the prepared inspection inventory", async () => {
    await withOpenClawTestState(
      { env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const events = state.path("tool-events.jsonl");
        const configFor = (label: string): OpenClawConfig => ({
          plugins: {
            allow: ["shared"],
            slots: { memory: "none" },
            load: { paths: [writeToolPlugin({ root: state.path(label), id: "shared", events })] },
          },
        });
        const config = configFor("original");
        const other = configFor("replacement");
        const cache = createPluginCache();
        try {
          await withPluginCache(cache, async () => {
            const loadContext = resolvePluginRuntimeLoadContext({ config, env: process.env });
            await expect(
              acquirePluginToolInspectionRegistry({
                loadContext,
                scopes: [{ context: { config: other, workspaceDir: state.workspaceDir } }],
              }),
            ).rejects.toThrow("conflicting source ownership for shared");
            expect(readEvents(events)).toEqual([]);
          });
        } finally {
          await cache[Symbol.asyncDispose]();
        }
      },
    );
  });
});
