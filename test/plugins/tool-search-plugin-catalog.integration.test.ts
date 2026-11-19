import { expect, it } from "vitest";
import { finalizeAgentTools } from "../../src/agents/agent-tools.finalize.js";
import { applyToolPolicyPipeline } from "../../src/agents/tool-policy-pipeline.js";
import {
  applyToolSearchCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
} from "../../src/agents/tool-search.js";
import type { AnyAgentTool } from "../../src/agents/tools/common.js";
import { createTestPluginApi } from "../../src/plugin-sdk/plugin-test-api.js";
import { getPluginToolMeta, setPluginToolMeta } from "../../src/plugins/tool-metadata.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";

it.each(["feishu", "file-transfer"])(
  "Tool Search preserves selected %s metadata and rejects excluded companions",
  async (pluginId) => {
    const registered: AnyAgentTool[] = [];
    const config = {
      channels: { feishu: { enabled: true, appId: "cli_test", appSecret: "unused" } },
      tools: { toolSearch: { enabled: true, mode: "tools" as const } },
    };
    const api = createTestPluginApi({
      id: pluginId,
      config,
      registerTool(tool, options) {
        if (typeof tool !== "function" && "contextVersion" in tool) {
          throw new Error("These catalog fixtures expect legacy or static tool registrations");
        }
        const resolved = typeof tool === "function" ? tool({ config }) : tool;
        for (const entry of resolved ? (Array.isArray(resolved) ? resolved : [resolved]) : []) {
          setPluginToolMeta(entry, { pluginId, optional: options?.optional === true });
          registered.push(entry);
        }
      },
    });
    if (pluginId === "feishu") {
      const surface = await loadBundledPluginFacade<{
        registerFeishuBitableTools(api: OpenClawPluginApi): void;
      }>({ pluginId, artifactBasename: "api.js" });
      surface.registerFeishuBitableTools(api);
    } else {
      const surface = await loadBundledPluginFacade<{
        default: { register(api: OpenClawPluginApi): void };
      }>({ pluginId, artifactBasename: "index.js" });
      surface.default.register(api);
    }
    expect(registered.length).toBeGreaterThan(1);

    for (const selected of registered) {
      const policy = { allow: [selected.name] };
      const authorized = applyToolPolicyPipeline({
        tools: registered,
        toolMeta: getPluginToolMeta,
        steps: [{ policy, label: "tools.allow", stripPluginOnlyAllowlist: true }],
        warn: () => {},
      });
      const tools = finalizeAgentTools({
        tools: authorized,
        hookContext: {},
        wrapBeforeToolCallHook: false,
      });
      const normalized = tools[0]!;
      const catalogRef = createToolSearchCatalogRef();
      try {
        const surface = applyToolSearchCatalog({
          tools: [...createToolSearchTools({ config, catalogRef }), ...tools],
          config,
          catalogRef,
        });
        const describeTool = surface.tools.find((tool) => tool.name === "tool_describe")!;
        const result = await describeTool.execute("describe-selected", { id: selected.name });
        const { name, description, parameters } = normalized;
        const metadata = { name, description, parameters };
        expect(result.details).toMatchObject(metadata);
        const content = result.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n");
        expect(JSON.parse(content)).toMatchObject(metadata);
        for (const companion of registered.filter((tool) => tool !== selected)) {
          await expect(
            describeTool.execute("describe-excluded", { id: companion.name }),
          ).rejects.toThrow(`Unknown tool id: ${companion.name}`);
        }
      } finally {
        clearToolSearchCatalog({ catalogRef });
      }
    }
  },
);
