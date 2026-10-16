import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "./harness/tool-surface-bridge.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { prepareAgentToolSurfacePresentation } from "./tool-surface-plan.js";

it.each<{
  name: string;
  api: string;
  hint?: "tools" | false;
  setting?: NonNullable<OpenClawConfig["tools"]>["toolSearch"];
  direct: boolean;
}>([
  { name: "native local Ollama", api: "ollama", hint: "tools", direct: true },
  { name: "known hosted Ollama", api: "ollama", hint: false, direct: false },
  { name: "unclassified native route", api: "ollama", direct: false },
  { name: "Ollama completions route", api: "openai-completions", hint: "tools", direct: false },
  { name: "another local transport", api: "openai-responses", hint: "tools", direct: false },
  { name: "explicit structured mode", api: "ollama", hint: "tools", setting: true, direct: false },
  {
    name: "explicit object",
    api: "ollama",
    hint: "tools",
    setting: { enabled: true },
    direct: false,
  },
  {
    name: "explicit directory",
    api: "ollama",
    hint: "tools",
    setting: { mode: "directory" },
    direct: false,
  },
  { name: "explicit disable", api: "ollama", hint: "tools", setting: false, direct: true },
])("exposes web and memory schemas for $name with explicit config taking precedence", (row) => {
  const config: OpenClawConfig = { tools: { toolSearch: row.setting } };
  const model = { api: row.api, toolSearchMode: row.hint };
  const runtime = createAgentHarnessToolSurfaceRuntimeCore({
    config,
    model,
    modelToolsEnabled: true,
  });
  try {
    const surface = runtime.compactTools(
      ["web_search", "web_fetch", "memory_search", "memory_get", "hidden_target"].map(
        createStubTool,
      ),
    );
    const names = new Set(surface.tools.map((tool) => tool.name));
    expect(names.has("web_search")).toBe(row.direct);
    expect(names.has("web_fetch")).toBe(row.direct);
    expect(names.has("memory_search")).toBe(row.direct);
    expect(names.has("memory_get")).toBe(row.direct);
    expect(names.has("hidden_target")).toBe(row.setting === false);
  } finally {
    runtime.cleanup();
  }
});

it.each([
  { search: "web_search", get: "web_fetch", pluginId: "web-search" },
  { search: "memory_search", get: "memory_get", pluginId: "memory-core" },
])("keeps $search policy and provenance checks", ({ search, get, pluginId }) => {
  const model = { api: "ollama", toolSearchMode: "tools" as const };
  const runtime = createAgentHarnessToolSurfaceRuntimeCore({ model, modelToolsEnabled: true });
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
  try {
    const surface = runtime.compactTools([searchTool, lookalike, createStubTool("hidden_target")]);
    expect(surface.tools.map((tool) => tool.name)).toContain(search);
    expect(surface.tools.map((tool) => tool.name)).not.toContain(get);
    const restricted = surface.promptToolPolicy.apply({ toolsAllow: ["hidden_target"] });
    expect(restricted.tools.map((tool) => tool.name)).not.toContain(search);
    expect(restricted.callableToolNames).not.toContain(search);
    expect(
      runtime.compactTools([createStubTool("hidden_target")]).tools.map((tool) => tool.name),
    ).not.toContain(get);
  } finally {
    runtime.cleanup();
  }
});

it("keeps web and memory tools deferred when Code Mode owns the surface", () => {
  const model = { api: "ollama", toolSearchMode: "tools" as const };
  const runtime = createAgentHarnessToolSurfaceRuntimeCore({
    config: { tools: { codeMode: true } },
    model,
    modelToolsEnabled: true,
  });
  try {
    const names = runtime
      .compactTools(["web_search", "web_fetch", "memory_search", "memory_get"].map(createStubTool))
      .tools.map((tool) => tool.name);
    expect(names).toEqual(["exec", "wait"]);
  } finally {
    runtime.cleanup();
  }
});

it("preserves the deferred web and memory tools in prepared worker presentations", () => {
  const model = { api: "ollama", toolSearchMode: "tools" as const };
  const runtime = createAgentHarnessToolSurfaceRuntimeCore({
    model,
    modelToolsEnabled: true,
    presentation: prepareAgentToolSurfacePresentation({
      model,
      toolsEnabled: true,
      isRawModelRun: false,
      forceDirectMessageTool: false,
    }),
  });
  try {
    const names = runtime
      .compactTools(["web_search", "web_fetch", "memory_search", "memory_get"].map(createStubTool))
      .tools.map((tool) => tool.name);
    expect(names).toEqual(["tool_search", "tool_describe", "dispatch_action"]);
  } finally {
    runtime.cleanup();
  }
});
