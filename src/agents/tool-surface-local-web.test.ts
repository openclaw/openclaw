import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "./harness/tool-surface-bridge.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { prepareAgentToolSurfacePresentation } from "./tool-surface-plan.js";

const model = { api: "ollama", toolSearchMode: "tools" as const };
const localTools = ["web_search", "web_fetch", "memory_search", "memory_get"];
const runtimes: ReturnType<typeof createAgentHarnessToolSurfaceRuntimeCore>[] = [];
function createRuntime(
  options: Partial<Parameters<typeof createAgentHarnessToolSurfaceRuntimeCore>[0]> = {},
) {
  const runtime = createAgentHarnessToolSurfaceRuntimeCore({
    model,
    modelToolsEnabled: true,
    ...options,
  });
  runtimes.push(runtime);
  return runtime;
}
afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.cleanup();
  }
});

it.each<
  [
    string,
    string,
    "tools" | false | undefined,
    NonNullable<OpenClawConfig["tools"]>["toolSearch"],
    boolean,
  ]
>([
  ["native local Ollama", "ollama", "tools", undefined, true],
  ["known hosted Ollama", "ollama", false, undefined, false],
  ["unclassified native route", "ollama", undefined, undefined, false],
  ["Ollama completions route", "openai-completions", "tools", undefined, false],
  ["another local transport", "openai-responses", "tools", undefined, false],
  ["explicit structured mode", "ollama", "tools", true, false],
  ["explicit object", "ollama", "tools", { enabled: true }, false],
  ["explicit directory", "ollama", "tools", { mode: "directory" }, false],
  ["explicit disable", "ollama", "tools", false, true],
])(
  "exposes web and memory schemas for %s with explicit config taking precedence",
  (_name, api, hint, setting, direct) => {
    const runtime = createRuntime({
      config: { tools: { toolSearch: setting } },
      model: { api, toolSearchMode: hint },
    });
    const surface = runtime.compactTools([...localTools, "hidden_target"].map(createStubTool));
    const names = new Set(surface.tools.map((tool) => tool.name));
    expect(localTools.map((name) => names.has(name))).toEqual(localTools.map(() => direct));
    expect(names.has("hidden_target")).toBe(setting === false);
  },
);

it.each([
  { search: "web_search", get: "web_fetch", pluginId: "web-search" },
  { search: "memory_search", get: "memory_get", pluginId: "memory-core" },
])("keeps $search policy and provenance checks", ({ search, get, pluginId }) => {
  const runtime = createRuntime();
  const searchTool = createStubTool(search);
  setPluginToolMeta(searchTool, { pluginId, optional: true });
  const lookalike = createStubTool(get);
  setPluginToolMeta(lookalike, {
    pluginId: "bundle-mcp",
    optional: true,
    mcp: {
      serverName: "fixture",
      safeServerName: "fixture",
      toolName: get,
      operation: "tool",
    },
  });
  const surface = runtime.compactTools([searchTool, lookalike, createStubTool("hidden_target")]);
  expect(surface.tools.map((tool) => tool.name)).toContain(search);
  expect(surface.tools.map((tool) => tool.name)).not.toContain(get);
  const restricted = surface.promptToolPolicy.apply({ toolsAllow: ["hidden_target"] });
  expect(restricted.tools.map((tool) => tool.name)).not.toContain(search);
  expect(restricted.callableToolNames).not.toContain(search);
  expect(
    runtime.compactTools([createStubTool("hidden_target")]).tools.map((tool) => tool.name),
  ).not.toContain(get);
});

it("keeps web and memory tools deferred when Code Mode owns the surface", () => {
  const runtime = createRuntime({
    config: { tools: { codeMode: true } },
  });
  const names = runtime.compactTools(localTools.map(createStubTool)).tools.map((tool) => tool.name);
  expect(names).toEqual(["exec", "wait"]);
});

it("preserves the deferred web and memory tools in prepared worker presentations", () => {
  const runtime = createRuntime({
    presentation: prepareAgentToolSurfacePresentation({
      model,
      toolsEnabled: true,
      isRawModelRun: false,
      forceDirectMessageTool: false,
    }),
  });
  const names = runtime.compactTools(localTools.map(createStubTool)).tools.map((tool) => tool.name);
  expect(names).toEqual(["tool_search", "tool_describe", "dispatch_action"]);
});
