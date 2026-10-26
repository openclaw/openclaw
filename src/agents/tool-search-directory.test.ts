import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAgentHarnessPromptToolPolicy } from "./harness/prompt-tool-policy.js";
import { filterLocalModelLeanTools } from "./local-model-lean.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { registerHeadlessToolSearchCatalog } from "./tool-search-catalog.js";
import type { ToolSearchCatalogRef } from "./tool-search-types.js";
import { buildToolSchemaDirectoryPrompt } from "./tool-search.js";

const optionalNames = [
  "browser",
  "automations",
  "message",
  "image_generate",
  "music_generate",
  "video_generate",
  "tts",
  "pdf",
];

function localCatalog() {
  return [
    ...Array.from({ length: 32 }, (_, i) => `local_tool_${String(i).padStart(2, "0")}`),
    ...optionalNames,
  ].map((name) =>
    Object.assign(createStubTool(name), { description: "Search the local archive. ".repeat(10) }),
  );
}

function catalogRef(tools: ReturnType<typeof localCatalog>): ToolSearchCatalogRef {
  const ref = {};
  registerHeadlessToolSearchCatalog({ catalogRef: ref, tools });
  return ref;
}

describe("lean Tool Search directory", () => {
  it("does not spend removed tools' prompt savings on longer descriptions", () => {
    const tools = localCatalog();
    const config: OpenClawConfig = {
      agents: { defaults: { experimental: { localModelLean: true } } },
      tools: { toolSearch: { mode: "tools" } },
    };
    const leanTools = filterLocalModelLeanTools({ tools, config });
    const options = { contextTokenBudget: 32_768 };
    const full = buildToolSchemaDirectoryPrompt({ catalogRef: catalogRef(tools) }, options);
    const lean = buildToolSchemaDirectoryPrompt(
      { config, catalogRef: catalogRef(leanTools) },
      options,
    );

    expect(lean.length).toBeLessThanOrEqual(full.length);
    expect(lean).not.toContain("Search the local archive");
    for (const name of optionalNames) {
      expect(lean).not.toContain(`- ${name} `);
    }
    for (const tool of leanTools) {
      expect(lean).toContain(`- ${tool.name} (core)`);
      expect(tool.description).toBe("Search the local archive. ".repeat(10));
    }
  });

  it("caches directory text separately for lean and non-lean agents", () => {
    const ref = catalogRef(localCatalog().slice(0, 1));
    const config: OpenClawConfig = {
      agents: {
        defaults: { experimental: { localModelLean: true } },
        entries: { lean: {}, full: { experimental: { localModelLean: false } } },
      },
    };
    const full = buildToolSchemaDirectoryPrompt({ config, agentId: "full", catalogRef: ref });
    const lean = buildToolSchemaDirectoryPrompt({ config, agentId: "lean", catalogRef: ref });

    expect(full).toContain("Search the local archive");
    expect(lean).toContain("- local_tool_00 (core)\n");
    expect(lean).not.toContain("Search the local archive");
    expect(buildToolSchemaDirectoryPrompt({ config, agentId: "full", catalogRef: ref })).toBe(full);
    expect(buildToolSchemaDirectoryPrompt({ config, agentId: "lean", catalogRef: ref })).toBe(lean);
    expect(
      buildToolSchemaDirectoryPrompt(
        { config, agentId: "full", catalogRef: ref },
        { toolSearchDirectoryLean: true },
      ),
    ).toBe(lean);
    expect(
      buildToolSchemaDirectoryPrompt(
        { config, agentId: "lean", catalogRef: ref },
        { toolSearchDirectoryLean: false },
      ),
    ).toBe(full);
    const policy = createAgentHarnessPromptToolPolicy({
      tools: [createStubTool("tool_search")],
      catalogRef: ref,
      codeModeControlsEnabled: false,
      catalogPrompt: { config, agentId: "full" },
    });
    expect(policy.apply().toolSchemaDirectoryPrompt).toBe(full);
  });
});
