import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import {
  makeAssistantMessage,
  reply,
} from "../../packages/agent-core/src/agent-loop.test-support.js";
import { Agent } from "../../packages/agent-core/src/agent.js";
import { buildOpenAIResponsesParams } from "../../packages/ai/src/transports/openai-responses-params-internal.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../packages/ai/src/utils/system-prompt-cache-boundary.js";
import { resolveProviderStreamFn } from "./provider-runtime.js";
import { PROVIDER_RUNTIME_TEST_MODEL as MODEL } from "./provider-runtime.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

afterEach(() => resetPluginRuntimeStateForTest());

it("carries prepared prompt bytes through a plugin's boundary stripping across live agents", async () => {
  const model = { ...MODEL, compat: { supportsInstructions: true } };
  const requests: string[] = [];
  const registry = createEmptyPluginRegistry();
  registry.providers = [
    {
      pluginId: "demo",
      source: "test",
      provider: {
        id: "demo",
        label: "Demo",
        auth: [],
        createStreamFn: () => (_model, context) => {
          requests.push(buildOpenAIResponsesParams(model, context, undefined).instructions ?? "");
          return reply(makeAssistantMessage([{ type: "text", text: "done" }]));
        },
      },
    },
  ];
  setActivePluginRegistry(registry, "startup-registry", "gateway-bindable", "/tmp/workspace");
  const agents = Array.from({ length: 65 }, (_, index) => {
    const streamFn = resolveProviderStreamFn({
      provider: "demo",
      workspaceDir: "/tmp/workspace",
      allowRuntimePluginLoad: false,
      context: { provider: "demo", modelId: model.id, model },
    });
    assert(streamFn);
    return new Agent({
      initialState: {
        model,
        systemPrompt: `Plugin ${index}${SYSTEM_PROMPT_CACHE_BOUNDARY}Keep 🦞.\ud800`,
      },
      streamFn,
    });
  });
  const replacements = vi.spyOn(String.prototype, "replaceAll");
  try {
    for (let round = 0; round < 2; round++) {
      for (const agent of agents) {
        await agent.prompt("continue");
      }
    }
    const expected = agents.map((_, index) => `Plugin ${index}\nKeep 🦞.`);
    expect(requests).toEqual([...expected, ...expected]);
    expect(
      replacements.mock.calls.filter(([marker]) => marker === SYSTEM_PROMPT_CACHE_BOUNDARY),
    ).toHaveLength(130);
  } finally {
    replacements.mockRestore();
  }
});
