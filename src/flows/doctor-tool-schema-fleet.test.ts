import { expect, it } from "vitest";
import { configFor, modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectRuntimeToolSchemaFindings } from "./doctor-tool-schema-runtime.js";

it("bounds metadata copies while inspecting a fleet's per-agent schemas", async () => {
  await withOpenClawTestState({ env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } }, async (state) => {
    await state.writeJson("extensions/fleet-tool/openclaw.plugin.json", {
      id: "fleet-tool",
      contracts: { tools: ["fleet-tool"] },
      configSchema: { type: "object", additionalProperties: false },
    });
    await state.writeText(
      "extensions/fleet-tool/index.cjs",
      `module.exports = { id: "fleet-tool", register(api) {
          api.registerTool(context => {
            return { name: "fleet-tool", label: "Fleet fixture", description: "Synthetic tool",
              parameters: context.agentId === "agent100" ? { type: "array", items: { type: "string" } } : { type: "object", properties: {} },
              execute: async () => ({ content: [], details: {} }) };
          }, { name: "fleet-tool" });
        } };`,
    );
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
                  tools: { allow: ["fleet-tool"] },
                },
              ]),
            ),
          },
          ...configFor("fixture", "http://127.0.0.1:1/v1", {
            api: "openai-completions",
            models: [modelDefinition("local", { name: "Local fixture", reasoning: false })],
          }),
          plugins: { allow: ["fleet-tool"], slots: { memory: "none" } },
        },
        { mode: "doctor", env: state.env },
      );
      expect(findings).toEqual([
        expect.objectContaining({
          severity: "error",
          target: "fleet-tool",
          message: expect.stringContaining("Agent agent100 tool fleet-tool"),
        }),
      ]);
      expect(indexClones).toBeLessThanOrEqual(3);
    } finally {
      globalThis.structuredClone = clone;
    }
  });
});
