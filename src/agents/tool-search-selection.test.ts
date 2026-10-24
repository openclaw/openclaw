import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { bindAgentToolAvailability } from "./agent-tool-availability.js";
import { createAgentHarnessPromptToolPolicy } from "./harness/prompt-tool-policy.js";
import { wrapToolDefinition } from "./sessions/tools/tool-definition-wrapper.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { filterToolsByPolicy } from "./tool-policy-match.js";
import { addClientToolsToToolCatalog } from "./tool-search-catalog.js";
import { resolveToolSearchCatalogTool } from "./tool-search-directory.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  createToolSearchSelectionMatcher,
  type ToolSearchSelection,
} from "./tool-search-selection.js";
import {
  applyToolSchemaDirectoryCatalog,
  applyToolSearchCatalog,
  buildToolSchemaDirectoryPrompt,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  resolveToolSearchConfig,
} from "./tool-search.js";
import type { AnyAgentTool } from "./tools/common.js";

function tool(name: string, source: "core" | "plugin" | "mcp" = "core"): AnyAgentTool {
  const result = {
    ...createStubTool(name),
    description: `${name} fixture`,
    execute: vi.fn(async (_id: string, args: unknown) => ({
      content: [],
      details: { name, args },
    })),
  };
  if (source !== "core") {
    setPluginToolMeta(result, {
      pluginId: "fixture-plugin",
      optional: false,
      ...(source === "mcp"
        ? {
            mcp: {
              serverName: "remote",
              safeServerName: "remote",
              toolName: `server_${name}`,
              operation: "tool" as const,
            },
          }
        : {}),
    });
  }
  return result;
}

describe("Tool Search selectors", () => {
  it.each([
    { selection: {}, expected: [true, true, true] },
    { selection: { include: [] }, expected: [false, false, false] },
    { selection: { exclude: [] }, expected: [true, true, true] },
    { selection: { include: [{ source: "mcp" }] }, expected: [false, true, false] },
    { selection: { include: [{ name: " GITHUB_READ_* " }] }, expected: [true, true, true] },
    {
      selection: { include: [{ source: "mcp", name: "github_read_*" }] },
      expected: [false, true, false],
    },
    {
      selection: { include: [{ source: "mcp", name: "github_write_*" }] },
      expected: [false, false, false],
    },
    {
      selection: { include: [{ source: "mcp" }, { source: "client" }] },
      expected: [false, true, true],
    },
    {
      selection: { include: [{ name: "*" }], exclude: [{ source: "mcp" }] },
      expected: [true, false, true],
    },
    {
      selection: { exclude: [{ source: "client", name: "*read*" }, { source: "openclaw" }] },
      expected: [false, true, false],
    },
    { selection: { include: [{ name: "github_read_.*" }] }, expected: [false, false, false] },
  ] satisfies Array<{ selection: ToolSearchSelection; expected: boolean[] }>)(
    "matches source/name AND, list OR, and exclusions: $selection",
    ({ selection, expected }) => {
      const selected = createToolSearchSelectionMatcher(selection);
      expect(
        (["openclaw", "mcp", "client"] as const).map((source) =>
          selected({ source, name: "github_read_issue" }),
        ),
      ).toEqual(expected);
    },
  );

  it("normalizes policy aliases without expanding groups or write grants", () => {
    const aliases = createToolSearchSelectionMatcher({ include: [{ name: " BASH " }] });
    expect(aliases({ source: "client", name: "exec" })).toBe(true);
    expect(aliases({ source: "mcp", name: " BASH " })).toBe(true);
    const groups = createToolSearchSelectionMatcher({ include: [{ name: "group:fs" }] });
    expect(groups({ source: "openclaw", name: "read" })).toBe(false);
    const write = createToolSearchSelectionMatcher({ include: [{ name: "write" }] });
    expect(write({ source: "openclaw", name: "apply_patch" })).toBe(false);
  });

  it.each(["tools", "directory"] as const)(
    "defers MCP schemas only, preserving callable direct tools in %s mode",
    async (mode) => {
      const config: OpenClawConfig = {
        tools: {
          toolSearch: {
            mode,
            include: [{ source: "mcp" }],
            exclude: [{ source: "mcp", name: "github_read_*" }],
          },
        },
      };
      const catalogRef = createToolSearchCatalogRef();
      const ctx = { config, catalogRef };
      const direct = [
        tool("core_lookup"),
        tool("mcp_named_plugin", "plugin"),
        tool("github_read_issue", "mcp"),
      ];
      const deferred = tool("github_write_issue", "mcp");
      const apply = mode === "directory" ? applyToolSchemaDirectoryCatalog : applyToolSearchCatalog;
      try {
        const surface = apply({
          ...ctx,
          tools: [...createToolSearchTools(ctx), ...direct, deferred],
        });
        const client = tool("client_pick_file");
        const clients = addClientToolsToToolCatalog({
          tools: [client],
          enabled: mode === "tools",
          selection: resolveToolSearchConfig(config),
          catalogRef,
        });
        expect(surface.tools).toEqual([
          ...createToolSearchTools(ctx).map((control) =>
            expect.objectContaining({ name: control.name }),
          ),
          ...direct,
        ]);
        expect(clients.tools).toEqual([client]);
        expect(catalogRef.current?.entries.map((entry) => entry.id)).toEqual([
          "mcp:remote:github_write_issue",
        ]);
        for (const target of [
          ...direct,
          ...clients.tools.map((definition) => wrapToolDefinition(definition)),
        ]) {
          expect(target.parameters).toBeDefined();
          await expect(target.execute("direct", {})).resolves.toMatchObject({
            details: { name: target.name },
          });
        }
        const control = (name: string) =>
          expectDefined(
            surface.tools.find((candidate) => candidate.name === name),
            name,
          );
        expect(
          await control("tool_search").execute("search", { query: deferred.name }),
        ).toMatchObject({
          details: [{ id: "mcp:remote:github_write_issue", source: "mcp", input: "unknown" }],
        });
        expect(
          await control("tool_describe").execute("describe", { id: deferred.name }),
        ).toMatchObject({
          details: { parameters: deferred.parameters },
        });
        expect(
          await control("dispatch_action").execute("call", { id: deferred.name, args: {} }),
        ).toMatchObject({
          details: {
            tool: { source: "mcp", name: deferred.name },
            result: { details: { name: deferred.name } },
          },
        });
        expect(buildToolSchemaDirectoryPrompt(ctx)).not.toContain("core_lookup");
      } finally {
        clearToolSearchCatalog({ catalogRef });
      }
    },
  );

  it.each(["tools", "directory"] as const)(
    "preserves direct-only and trusted required/coding guarantees in %s mode",
    (mode) => {
      const config: OpenClawConfig = { tools: { toolSearch: { mode, include: [{ name: "*" }] } } };
      const catalogRef = createToolSearchCatalogRef();
      const ctx = { config, catalogRef };
      const directOnly = tool("direct_contract", "mcp");
      directOnly.catalogMode = "direct-only";
      const trusted = [tool("read"), tool("message")];
      const lookalikes = [tool("write", "mcp"), tool("message", "mcp")];
      const apply = mode === "directory" ? applyToolSchemaDirectoryCatalog : applyToolSearchCatalog;
      try {
        const surface = apply({
          ...ctx,
          tools: [...createToolSearchTools(ctx), directOnly, ...trusted, ...lookalikes],
          directToolNames: ["message"],
        });
        expect(surface.tools).toContain(directOnly);
        expect(surface.tools).toContain(trusted[0]);
        // Directory's existing cross-source collision gate also hides trusted message.
        expect(surface.tools.includes(trusted[1]!)).toBe(mode === "tools");
        for (const target of lookalikes) {
          expect(surface.tools).not.toContain(target);
        }
        expect(catalogRef.current?.entries.map((entry) => entry.name)).not.toContain(
          "direct_contract",
        );
      } finally {
        clearToolSearchCatalog({ catalogRef });
      }
    },
  );

  it("keeps split direct/deferred names ambiguous across inventory and prompt-policy refreshes", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config: OpenClawConfig = {
      tools: { toolSearch: { mode: "directory", include: [{ source: "openclaw" }] } },
    };
    const ctx = { config, catalogRef };
    const native = tool("acme_lookup", "plugin");
    setPluginToolMeta(native, { pluginId: "acme", optional: false });
    const direct = tool("acme_lookup", "mcp");
    const apply = (includeDirect: boolean) =>
      applyToolSchemaDirectoryCatalog({
        ...ctx,
        tools: [...createToolSearchTools(ctx), native, ...(includeDirect ? [direct] : [])],
      });
    const runtime = new ToolSearchRuntime(ctx, resolveToolSearchConfig(config));
    const ambiguous = "Ambiguous tool name: acme_lookup; use an exact tool id.";
    try {
      const surface = apply(true);
      expect(surface.tools).toContain(direct);
      expect(surface.tools).not.toContain(native);
      expect(buildToolSchemaDirectoryPrompt(ctx)).not.toContain("- acme_lookup (acme)");
      expect(resolveToolSearchCatalogTool(ctx, "acme_lookup")).toBeUndefined();
      await expect(runtime.describe("acme_lookup")).rejects.toThrow(ambiguous);
      await expect(runtime.call("acme_lookup", {})).rejects.toThrow(ambiguous);
      await expect(runtime.call("acme_lookupp", {})).rejects.toThrow(
        "Did you mean: openclaw:acme:acme_lookup",
      );
      expect(native.execute).not.toHaveBeenCalled();
      expect(direct.execute).not.toHaveBeenCalled();
      await runtime.call("openclaw:acme:acme_lookup", {});
      await direct.execute("direct-call", {});
      expect(native.execute).toHaveBeenCalledOnce();
      expect(direct.execute).toHaveBeenCalledOnce();

      const policy = createAgentHarnessPromptToolPolicy({
        tools: surface.tools,
        catalogRef,
        codeModeControlsEnabled: false,
        catalogPrompt: { config },
      });
      policy.apply({ toolsAllow: ["acme"] });
      expect(buildToolSchemaDirectoryPrompt(ctx)).toContain("- acme_lookup (acme)");
      await expect(runtime.describe("acme_lookup")).resolves.toMatchObject({ source: "openclaw" });
      policy.apply();
      expect(buildToolSchemaDirectoryPrompt(ctx)).not.toContain("- acme_lookup (acme)");
      await expect(runtime.call("acme_lookup", {})).rejects.toThrow(ambiguous);

      apply(false);
      expect(buildToolSchemaDirectoryPrompt(ctx)).toContain("- acme_lookup (acme)");
      expect(resolveToolSearchCatalogTool(ctx, "acme_lookup")).toBe(native);
      apply(true);
      expect(buildToolSchemaDirectoryPrompt(ctx)).not.toContain("- acme_lookup (acme)");
      expect(resolveToolSearchCatalogTool(ctx, "acme_lookup")).toBeUndefined();
    } finally {
      clearToolSearchCatalog({ catalogRef });
    }
  });

  it("never reintroduces denied tools and invalidates selected catalogs and cached guidance", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const targets = [tool("allowed_lookup"), tool("denied_lookup"), tool("other_lookup")];
    const apply = (selection: ToolSearchSelection) => {
      const config: OpenClawConfig = { tools: { toolSearch: { mode: "tools", ...selection } } };
      const ctx = { config, catalogRef };
      const surface = applyToolSearchCatalog({
        ...ctx,
        tools: [
          ...createToolSearchTools(ctx),
          ...filterToolsByPolicy(targets, { deny: ["denied_lookup"] }),
        ],
      });
      return { surface, ctx };
    };
    try {
      const first = apply({ include: [{ name: "*lookup" }] });
      const runtime = new ToolSearchRuntime(first.ctx, resolveToolSearchConfig(first.ctx.config));
      expect(buildToolSchemaDirectoryPrompt(first.ctx)).toContain("allowed_lookup");
      await expect(runtime.call("denied_lookup", {})).rejects.toThrow("Unknown tool");
      const second = apply({ include: [{ name: "other_lookup" }] });
      expect(second.surface.catalogReused).toBe(false);
      expect(buildToolSchemaDirectoryPrompt(second.ctx)).not.toContain("allowed_lookup");
      expect(
        (await runtime.search("allowed_lookup")).some((entry) => entry.name === "allowed_lookup"),
      ).toBe(false);
      await expect(runtime.call("allowed_lookup", {})).rejects.toThrow("Unknown tool");
      const empty = apply({ include: [] });
      expect(empty.surface.tools.map((entry) => entry.name)).toContain("allowed_lookup");
      expect(catalogRef.current?.entries).toEqual([]);
      expect(buildToolSchemaDirectoryPrompt(empty.ctx)).toBe(
        "Available deferred-schema tools: none.",
      );
    } finally {
      clearToolSearchCatalog({ catalogRef });
    }
  });

  it.each([false, { enabled: false, include: [{ source: "mcp" as const }] }])(
    "leaves explicitly disabled Tool Search disabled: %j",
    (toolSearch) => {
      const tools = [tool("remote", "mcp")];
      const catalogRef = createToolSearchCatalogRef();
      expect(
        applyToolSearchCatalog({ tools, config: { tools: { toolSearch } }, catalogRef }).tools,
      ).toEqual(tools);
      expect(catalogRef.current).toBeUndefined();
    },
  );

  it("preserves availability across the direct/catalog split and applies prompt restrictions", () => {
    const catalogRef = createToolSearchCatalogRef();
    const config: OpenClawConfig = { tools: { toolSearch: { include: [{ name: "dependent" }] } } };
    const dependency = tool("dependency");
    const dependent = bindAgentToolAvailability(tool("dependent"), {
      prepare: (target, callable) => {
        target.description = callable.has("dependency")
          ? "dependency available"
          : "dependency unavailable";
      },
    });
    try {
      const surface = applyToolSearchCatalog({
        config,
        catalogRef,
        tools: [...createToolSearchTools({ config, catalogRef }), dependent, dependency],
      });
      const entry = () => expectDefined(catalogRef.current?.entries[0], "dependent entry");
      expect(entry().description).toBe("dependency available");
      const policy = createAgentHarnessPromptToolPolicy({
        tools: surface.tools,
        catalogRef,
        codeModeControlsEnabled: false,
      });
      policy.apply({ toolsAllow: ["dependent"] });
      expect(entry().description).toBe("dependency unavailable");
      policy.apply();
      expect(entry().description).toBe("dependency available");
    } finally {
      clearToolSearchCatalog({ catalogRef });
    }
  });

  it.each(["client", "mcp"] as const)(
    "does not authorize a deferred %s lookalike through an allowed direct plugin",
    async (source) => {
      const catalogRef = createToolSearchCatalogRef();
      const config: OpenClawConfig = {
        tools: { toolSearch: { mode: "tools", include: [{ source }] } },
      };
      const ctx = { config, catalogRef };
      const direct = tool("acme_lookup", "plugin");
      setPluginToolMeta(direct, { pluginId: "acme", optional: false });
      const foreign = tool("acme_lookup", source === "mcp" ? "mcp" : "core");
      try {
        const surface = applyToolSearchCatalog({
          ...ctx,
          tools: [...createToolSearchTools(ctx), direct, ...(source === "mcp" ? [foreign] : [])],
        });
        if (source === "client") {
          addClientToolsToToolCatalog({
            catalogRef,
            tools: [foreign],
            enabled: true,
            selection: resolveToolSearchConfig(config),
          });
        }
        const entry = expectDefined(catalogRef.current?.entries[0], "foreign catalog entry");
        expect(entry.source).toBe(source);
        const call = expectDefined(
          surface.tools.find((candidate) => candidate.name === "dispatch_action"),
          "call control",
        );
        const policy = createAgentHarnessPromptToolPolicy({
          tools: surface.tools,
          catalogRef,
          codeModeControlsEnabled: false,
          catalogPrompt: { config },
        });
        const restricted = policy.apply({ toolsAllow: ["acme"] });

        await expect(call.execute("denied-call", { id: entry.id, args: {} })).rejects.toThrow(
          "Unknown tool",
        );
        expect(foreign.execute).not.toHaveBeenCalled();
        expect(catalogRef.current?.entries).toEqual([]);
        expect(restricted.tools).toEqual([direct]);
        expect(restricted.callableToolNames).toEqual(["acme_lookup"]);
        expect(restricted.toolSchemaDirectoryPrompt).toBeUndefined();
        await expect(direct.execute("direct-call", {})).resolves.toMatchObject({
          details: { name: "acme_lookup" },
        });

        policy.apply();
        await expect(
          call.execute("restored-call", { id: entry.id, args: {} }),
        ).resolves.toMatchObject({
          details: { tool: { id: entry.id, source } },
        });
        expect(foreign.execute).toHaveBeenCalledTimes(1);
        expect(policy.apply({ toolsAllow: [] }).tools).toEqual([]);
        expect(catalogRef.current?.entries).toEqual([]);
      } finally {
        clearToolSearchCatalog({ catalogRef });
      }
    },
  );
});
