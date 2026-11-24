// On-demand tools stay out of the provider tool list until the session calls them by name.
import { afterEach, describe, expect, it } from "vitest";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCatalogCodeModeHarness,
  createCodeModeHarness,
  resetCodeModeTestState,
} from "./code-mode.test-support.js";
import { createReadTool } from "./sessions/tools/read.js";
import type { ToolSearchCatalogRef } from "./tool-search-types.js";
import {
  applyToolSchemaDirectoryCatalog,
  applyToolSearchCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
} from "./tool-search.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createComputerTool } from "./tools/computer-tool.js";
import { createGitHubPublishTool } from "./tools/github-publish-tool.js";

const refs: ToolSearchCatalogRef[] = [];
afterEach(async () => {
  for (const catalogRef of refs.splice(0)) {
    clearToolSearchCatalog({ catalogRef });
  }
  await resetCodeModeTestState();
});

// The two always-built heavy tools of a default unsandboxed vision run, beside a core tool.
function defaultTargets(): AnyAgentTool[] {
  return [createReadTool("/tmp/on-demand"), createComputerTool(), createGitHubPublishTool()];
}

// The embedded runner opts in; it loads an on-demand tool on its first direct call.
function loadingCatalogRef(): ToolSearchCatalogRef {
  const catalogRef = createToolSearchCatalogRef();
  catalogRef.loadsOnDemandTools = true;
  refs.push(catalogRef);
  return catalogRef;
}

function toolSearchSurface(mode: "tools" | "directory", promoted?: string[]) {
  const config = { tools: { toolSearch: { mode } } };
  const catalogRef = loadingCatalogRef();
  if (promoted) {
    catalogRef.promotedToolNames = new Set(promoted);
  }
  const ctx = { config, catalogRef };
  const apply = mode === "tools" ? applyToolSearchCatalog : applyToolSchemaDirectoryCatalog;
  const { tools } = apply({ ...ctx, tools: [...createToolSearchTools(ctx), ...defaultTargets()] });
  return { catalogRef, ctx, tools };
}

function codeModeSurface(promoted?: string[]) {
  const harness = createCodeModeHarness({ catalogRef: loadingCatalogRef() });
  if (promoted) {
    harness.catalogRef.promotedToolNames = new Set(promoted);
  }
  const { tools } = applyCodeModeCatalog({
    ...harness.ctx,
    tools: [...harness.tools, ...defaultTargets()],
  });
  return { catalogRef: harness.catalogRef, tools };
}

const catalogNames = (catalogRef: ToolSearchCatalogRef) =>
  catalogRef.current?.entries.map((entry) => entry.name) ?? [];
const names = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name);

describe.each([
  [
    "Tool Search tools mode",
    () => toolSearchSurface("tools"),
    (p: string[]) => toolSearchSurface("tools", p),
  ],
  [
    "Tool Search directory mode",
    () => toolSearchSurface("directory"),
    (p: string[]) => toolSearchSurface("directory", p),
  ],
  ["Code Mode", () => codeModeSurface(), (p: string[]) => codeModeSurface(p)],
] as const)("%s", (_mode, build, buildPromoted) => {
  it("defers computer and github_publish until the session promotes them", () => {
    const { catalogRef, tools } = build();
    expect(names(tools)).not.toContain("computer");
    expect(names(tools)).not.toContain("github_publish");
    expect(catalogNames(catalogRef)).toEqual(
      expect.arrayContaining(["computer", "github_publish"]),
    );
    expect(catalogRef.current?.entries.find((entry) => entry.name === "computer")?.onDemand).toBe(
      true,
    );
  });

  it("keeps a promoted tool direct and out of the catalog", () => {
    const { catalogRef, tools } = buildPromoted(["computer"]);
    expect(names(tools)).toContain("computer");
    expect(names(tools)).not.toContain("github_publish");
    expect(catalogNames(catalogRef)).not.toContain("computer");
    expect(catalogNames(catalogRef)).toContain("github_publish");
    expect(catalogRef.directOnlyToolNames?.has("computer")).toBe(true);
  });
});

it("tells the model to call an on-demand tool by name and refuses catalog dispatch", async () => {
  const { tools } = toolSearchSurface("tools");
  const control = (name: string) => tools.find((tool) => tool.name === name)!;
  const search = await control("tool_search").execute("search", { query: "computer desktop" });
  expect(JSON.stringify(search.content)).toContain(
    "top-level by name; not dispatch_action or exec",
  );
  const described = await control("tool_describe").execute("describe", { id: "computer" });
  expect(JSON.stringify(described.content)).toContain("top-level by name");
  await expect(
    control("dispatch_action").execute("call", { id: "computer", args: { action: "screenshot" } }),
  ).rejects.toThrow(
    "computer runs only as its own top-level tool call. Call computer directly by name",
  );
});

it("refuses an on-demand tool called from Code Mode guest code", async () => {
  const target: AnyAgentTool = {
    name: "probe_screen",
    label: "probe_screen",
    description: "Capture the screen.",
    parameters: { type: "object", properties: {} },
    catalogMode: "on-demand",
    execute: async () => {
      throw new Error("guest code must not run an on-demand tool");
    },
  };
  const harness = createCatalogCodeModeHarness([target], { catalogRef: loadingCatalogRef() });
  const result = await harness.complete(
    "try { return await probe_screen({}); } catch (error) { return error.message; }",
  );
  expect(result).toMatchObject({
    status: "completed",
    value: expect.stringContaining("probe_screen runs only as its own top-level tool call"),
  });
});

it("keeps on-demand tools direct for a runner that cannot load them on use", () => {
  const config = { tools: { toolSearch: { mode: "tools" as const } } };
  const catalogRef = createToolSearchCatalogRef();
  refs.push(catalogRef);
  const ctx = { config, catalogRef };
  const { tools } = applyToolSearchCatalog({
    ...ctx,
    tools: [...createToolSearchTools(ctx), ...defaultTargets()],
  });
  expect(names(tools)).toEqual(expect.arrayContaining(["computer", "github_publish"]));
  expect(catalogNames(catalogRef)).not.toContain("computer");
  expect(catalogNames(catalogRef)).not.toContain("github_publish");
});

it("keeps on-demand tools out of a headless catalog, like direct-only tools", () => {
  const catalogRef = createToolSearchCatalogRef();
  refs.push(catalogRef);
  registerHeadlessToolSearchCatalog({ catalogRef, tools: defaultTargets() });
  expect(catalogNames(catalogRef)).toEqual(["read"]);
});
