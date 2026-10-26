import path from "node:path";
import { expect, it, vi } from "vitest";
import { configFor, modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import * as indexes from "../plugins/installed-plugin-index-record-builder.js";
import * as owners from "../plugins/provider-owner-index.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectRuntimeToolSchemaFindings } from "./doctor-tool-schema-runtime.js";

it("shares metadata across a fleet while inspecting each workspace's actual tools", async () => {
  await withOpenClawTestState({ env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } }, async (state) => {
    const event = `doctor-fleet-tools:${state.root}`;
    const factories: Array<{ agentId: string; workspaceDir: string }> = [];
    const onFactory = (context: { agentId: string; workspaceDir: string }) =>
      factories.push(context);
    for (const [directory, id] of [
      [state.statePath("extensions/fleet-tool"), "fleet-tool"],
      [state.path("workspace100/.openclaw/extensions/workspace-tool"), "workspace-tool"],
    ] as const) {
      const relative = path.relative(state.stateDir, directory);
      await state.writeJson(`${relative}/openclaw.plugin.json`, {
        id,
        contracts: { tools: [id] },
        configSchema: { type: "object", additionalProperties: false },
      });
      await state.writeText(
        `${relative}/index.cjs`,
        `module.exports = { id: ${JSON.stringify(id)}, register(api) {
          api.registerTool(context => {
            if (${JSON.stringify(id)} === "fleet-tool") process.emit(${JSON.stringify(event)}, {
              agentId: context.agentId, workspaceDir: context.workspaceDir
            });
            return { name: ${JSON.stringify(id)}, label: "Fleet fixture", description: "Synthetic tool",
              parameters: context.agentId === "agent100" ? { type: "array", items: { type: "string" } } : { type: "object", properties: {} },
              execute: async () => ({ content: [], details: {} }) };
          }, { name: ${JSON.stringify(id)} });
        } };`,
      );
    }
    const builds = vi.spyOn(owners, "buildDeclaredProviderOwnerIndex");
    const indexBuilds = vi.spyOn(indexes, "buildInstalledPluginIndexRecords");
    const clone = globalThis.structuredClone;
    let indexClones = 0;
    globalThis.structuredClone = (value, options) => {
      if (
        value &&
        typeof value === "object" &&
        Object.hasOwn(value, "plugins") &&
        Object.hasOwn(value, "policyHash")
      ) {
        indexClones++;
      }
      return clone(value, options);
    };
    process.on(event, onFactory);
    const started = performance.now();
    try {
      const findings = await collectRuntimeToolSchemaFindings(
        {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "agent0" }, model: "fixture/local" },
            entries: Object.fromEntries(
              Array.from({ length: 200 }, (_, i) => [
                `agent${i}`,
                {
                  workspace: state.path(`workspace${i}`),
                  tools: { allow: ["fleet-tool", "workspace-tool"] },
                },
              ]),
            ),
          },
          ...configFor("fixture", "http://127.0.0.1:1/v1", {
            api: "openai-completions",
            models: [modelDefinition("local", { name: "Local fixture", reasoning: false })],
          }),
          plugins: { allow: ["fleet-tool", "workspace-tool"], slots: { memory: "none" } },
        },
        { mode: "doctor", env: state.env },
      );
      expect(findings).toEqual(
        ["fleet-tool", "workspace-tool"].map((target) =>
          expect.objectContaining({
            severity: "error",
            target,
            message: expect.stringContaining(`Agent agent100 tool ${target}`),
          }),
        ),
      );
      expect(factories).toEqual(
        Array.from({ length: 200 }, (_, i) => ({
          agentId: `agent${i}`,
          workspaceDir: state.path(`workspace${i}`),
        })),
      );
      console.log(
        JSON.stringify({
          agents: 200,
          elapsedMs: performance.now() - started,
          ownerBuilds: builds.mock.calls.length,
          indexBuilds: indexBuilds.mock.calls.length,
          indexClones,
        }),
      );
      // Shared, workspace-local, fleet-union, and their two tool-owner projections.
      expect(builds.mock.calls.length).toBe(5);
      expect(indexBuilds).toHaveBeenCalledTimes(2);
      expect(indexClones).toBeLessThanOrEqual(3);
    } finally {
      globalThis.structuredClone = clone;
      process.off(event, onFactory);
      builds.mockRestore();
      indexBuilds.mockRestore();
    }
  });
});
