import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "./harness/tool-surface-bridge.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";

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
])("exposes web schemas for $name with explicit config taking precedence", (row) => {
  const config: OpenClawConfig = { tools: { toolSearch: row.setting } };
  const model = { api: row.api, toolSearchMode: row.hint };
  const runtime = createAgentHarnessToolSurfaceRuntimeCore({
    config,
    model,
    modelToolsEnabled: true,
  });
  try {
    const surface = runtime.compactTools(
      ["web_search", "web_fetch", "hidden_target"].map(createStubTool),
    );
    const names = new Set(surface.tools.map((tool) => tool.name));
    expect(names.has("web_search")).toBe(row.direct);
    expect(names.has("web_fetch")).toBe(row.direct);
    expect(names.has("hidden_target")).toBe(row.setting === false);
  } finally {
    runtime.cleanup();
  }
});

it("does not restore withheld tools or expose an MCP lookalike, and honors prompt restrictions", () => {
  const model = { api: "ollama", toolSearchMode: "tools" as const };
  const runtime = createAgentHarnessToolSurfaceRuntimeCore({ model, modelToolsEnabled: true });
  const lookalike = createStubTool("web_fetch");
  setPluginToolMeta(lookalike, {
    pluginId: "bundle-mcp",
    mcp: {
      serverName: "fixture",
      safeServerName: "fixture",
      toolName: "web_fetch",
      operation: "tool",
    },
  });
  try {
    const surface = runtime.compactTools([
      createStubTool("web_search"),
      lookalike,
      createStubTool("hidden_target"),
    ]);
    expect(surface.tools.map((tool) => tool.name)).toContain("web_search");
    expect(surface.tools.map((tool) => tool.name)).not.toContain("web_fetch");
    const restricted = surface.promptToolPolicy.apply({ toolsAllow: ["hidden_target"] });
    expect(restricted.tools.map((tool) => tool.name)).not.toContain("web_search");
    expect(restricted.callableToolNames).not.toContain("web_search");
    expect(
      runtime.compactTools([createStubTool("hidden_target")]).tools.map((tool) => tool.name),
    ).not.toContain("web_fetch");
  } finally {
    runtime.cleanup();
  }
});

it("keeps web tools deferred when Code Mode owns the surface", () => {
  const model = { api: "ollama", toolSearchMode: "tools" as const };
  const runtime = createAgentHarnessToolSurfaceRuntimeCore({
    config: { tools: { codeMode: true } },
    model,
    modelToolsEnabled: true,
  });
  try {
    const names = runtime
      .compactTools(["web_search", "web_fetch"].map(createStubTool))
      .tools.map((tool) => tool.name);
    expect(names).toEqual(["exec", "wait"]);
  } finally {
    runtime.cleanup();
  }
});
