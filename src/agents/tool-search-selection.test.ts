import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { bindAgentToolAvailability } from "./agent-tool-availability.js";
import { createAgentHarnessPromptToolPolicy } from "./harness/prompt-tool-policy.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { filterToolsByPolicy } from "./tool-policy-match.js";
import { addClientToolsToToolCatalog } from "./tool-search-catalog.js";
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
  resolveToolSearchCatalogTool,
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

function catalog(selection: ToolSearchSelection, mode?: "tools" | "directory") {
  const config: OpenClawConfig = {
    tools: { toolSearch: { ...selection, ...(mode ? { mode } : {}) } },
  };
  const catalogRef = createToolSearchCatalogRef();
  return {
    config,
    catalogRef,
    [Symbol.dispose]: () => clearToolSearchCatalog({ catalogRef }),
  };
}
function promptPolicy(ctx: ReturnType<typeof catalog>, tools: AnyAgentTool[], withPrompt = true) {
  return createAgentHarnessPromptToolPolicy({
    tools,
    catalogRef: ctx.catalogRef,
    codeModeControlsEnabled: false,
    ...(withPrompt ? { catalogPrompt: { config: ctx.config } } : {}),
  });
}
function applyCatalog(
  ctx: Pick<ReturnType<typeof catalog>, "config" | "catalogRef">,
  tools: AnyAgentTool[],
  directToolNames?: string[],
) {
  const apply =
    resolveToolSearchConfig(ctx.config).mode === "directory"
      ? applyToolSchemaDirectoryCatalog
      : applyToolSearchCatalog;
  return apply({ ...ctx, tools: [...createToolSearchTools(ctx), ...tools], directToolNames });
}

describe("Tool Search selectors", () => {
  it.each([
    [{}, [true, true, true]],
    [{ include: [] }, [false, false, false]],
    [{ exclude: [] }, [true, true, true]],
    [{ include: [{ source: "mcp" }] }, [false, true, false]],
    [{ include: [{ name: " GITHUB_READ_* " }] }, [true, true, true]],
    [{ include: [{ source: "mcp", name: "github_read_*" }] }, [false, true, false]],
    [{ include: [{ source: "mcp", name: "github_write_*" }] }, [false, false, false]],
    [{ include: [{ source: "mcp" }, { source: "client" }] }, [false, true, true]],
    [{ include: [{ name: "*" }], exclude: [{ source: "mcp" }] }, [true, false, true]],
    [
      { exclude: [{ source: "client", name: "*read*" }, { source: "openclaw" }] },
      [false, true, false],
    ],
    [{ include: [{ name: "github_read_.*" }] }, [false, false, false]],
  ] satisfies Array<[ToolSearchSelection, boolean[]]>)(
    "matches source/name AND, list OR, and exclusions: %j",
    (selection, expected) => {
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
    (mode) => {
      using ctx = catalog(
        {
          include: [{ source: "mcp" }],
          exclude: [{ source: "mcp", name: "github_read_*" }],
        },
        mode,
      );
      const { config, catalogRef } = ctx;
      const direct = [
        tool("core_lookup"),
        tool("mcp_named_plugin", "plugin"),
        tool("github_read_issue", "mcp"),
      ];
      const deferred = tool("github_write_issue", "mcp");
      const surface = applyCatalog(ctx, [...direct, deferred]);
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
      expect(buildToolSchemaDirectoryPrompt(ctx)).not.toContain("core_lookup");
    },
  );

  it.each(["tools", "directory"] as const)(
    "preserves trusted required/coding guarantees in %s mode",
    (mode) => {
      using ctx = catalog({ include: [{ name: "*" }] }, mode);
      const trusted = [tool("read"), tool("message")];
      const lookalikes = [tool("write", "mcp"), tool("message", "mcp")];
      const surface = applyCatalog(ctx, [...trusted, ...lookalikes], ["message"]);
      expect(surface.tools).toContain(trusted[0]);
      // Directory's existing cross-source collision gate also hides trusted message.
      expect(surface.tools.includes(trusted[1]!)).toBe(mode === "tools");
      for (const target of lookalikes) {
        expect(surface.tools).not.toContain(target);
      }
    },
  );

  it("keeps split direct/deferred names ambiguous across inventory and prompt-policy refreshes", async () => {
    using ctx = catalog({ include: [{ source: "openclaw" }] }, "directory");
    const native = tool("acme_lookup", "plugin");
    setPluginToolMeta(native, { pluginId: "acme", optional: false });
    const direct = tool("acme_lookup", "mcp");
    const apply = (includeDirect: boolean) =>
      applyCatalog(ctx, [native, ...(includeDirect ? [direct] : [])]);
    const runtime = new ToolSearchRuntime(ctx, resolveToolSearchConfig(ctx.config));
    const ambiguous = "Ambiguous tool name: acme_lookup; use an exact tool id.";
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

    const policy = promptPolicy(ctx, surface.tools);
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
  });

  it("never reintroduces denied tools and invalidates selected catalogs and cached guidance", async () => {
    using cleanup = catalog({});
    const { catalogRef } = cleanup;
    const targets = [tool("allowed_lookup"), tool("denied_lookup"), tool("other_lookup")];
    const apply = (selection: ToolSearchSelection) => {
      const config: OpenClawConfig = { tools: { toolSearch: { mode: "tools", ...selection } } };
      const ctx = { config, catalogRef };
      const surface = applyCatalog(ctx, filterToolsByPolicy(targets, { deny: ["denied_lookup"] }));
      return { surface, ctx };
    };
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
  });

  it("preserves availability across the direct/catalog split and applies prompt restrictions", () => {
    using ctx = catalog({ include: [{ name: "dependent" }] });
    const { catalogRef } = ctx;
    const dependency = tool("dependency");
    const dependent = bindAgentToolAvailability(tool("dependent"), {
      prepare: (target, callable) => {
        target.description = callable.has("dependency")
          ? "dependency available"
          : "dependency unavailable";
      },
    });
    const surface = applyCatalog(ctx, [dependent, dependency]);
    const entry = () => expectDefined(catalogRef.current?.entries[0], "dependent entry");
    expect(entry().description).toBe("dependency available");
    const policy = promptPolicy(ctx, surface.tools, false);
    policy.apply({ toolsAllow: ["dependent"] });
    expect(entry().description).toBe("dependency unavailable");
    policy.apply();
    expect(entry().description).toBe("dependency available");
  });

  it.each(["client", "mcp"] as const)(
    "does not authorize a deferred %s lookalike through an allowed direct plugin",
    async (source) => {
      using ctx = catalog({ include: [{ source }] }, "tools");
      const { config, catalogRef } = ctx;
      const direct = tool("acme_lookup", "plugin");
      setPluginToolMeta(direct, { pluginId: "acme", optional: false });
      const foreign = tool("acme_lookup", source === "mcp" ? "mcp" : "core");
      const surface = applyCatalog(ctx, [direct, ...(source === "mcp" ? [foreign] : [])]);
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
      const policy = promptPolicy(ctx, surface.tools);
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
    },
  );
});
