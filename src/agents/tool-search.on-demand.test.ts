// On-demand tools stay out of the provider tool list until the model looks them up or calls them.
import { afterEach, expect, it } from "vitest";
import { applyCodeModeCatalog, buildCodeModeCatalogPrompt } from "./code-mode.js";
import { createCodeModeHarness, resetCodeModeTestState } from "./code-mode.test-support.js";
import { createReadTool } from "./sessions/tools/read.js";
import type { ToolSearchCatalogRef } from "./tool-search-types.js";
import {
  applyToolSchemaDirectoryCatalog,
  applyToolSearchCatalog,
  buildToolSchemaDirectoryPrompt,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
} from "./tool-search.js";
import { createComputerTool } from "./tools/computer-tool.js";
import { createGitHubPublishTool } from "./tools/github-publish-tool.js";

const refs: ToolSearchCatalogRef[] = [];
afterEach(async () => {
  refs.splice(0).forEach((catalogRef) => clearToolSearchCatalog({ catalogRef }));
  await resetCodeModeTestState();
});
// The two always-built heavy tools of a default unsandboxed vision run, beside a core tool.
const targets = () => [createReadTool("/tmp/od"), createComputerTool(), createGitHubPublishTool()];
type Mode = "tools" | "directory" | "code-mode";

/** `loads` is the embedded runner's opt-in: it loads an on-demand tool on its first direct call. */
function surface(mode: Mode, options: { loads?: boolean; promoted?: string[] } = {}) {
  const catalogRef = createToolSearchCatalogRef();
  refs.push(catalogRef);
  catalogRef.loadsOnDemandTools = options.loads === false ? undefined : true;
  catalogRef.promotedToolNames = new Set(options.promoted);
  const ctx = { config: { tools: { toolSearch: { mode: mode as "tools" } } }, catalogRef };
  const harness = mode === "code-mode" ? createCodeModeHarness({ catalogRef }) : undefined;
  const { tools } = harness
    ? applyCodeModeCatalog({ ...harness.ctx, tools: [...harness.tools, ...targets()] })
    : (mode === "tools" ? applyToolSearchCatalog : applyToolSchemaDirectoryCatalog)({
        ...ctx,
        tools: [...createToolSearchTools(ctx), ...targets()],
      });
  const catalog = catalogRef.current?.entries.map((entry) => entry.name) ?? [];
  return { catalogRef, tools, sent: tools.map((tool) => tool.name), catalog };
}

const heavy = (names: string[]) => ["computer", "github_publish"].filter((n) => names.includes(n));

it.each(["tools", "directory", "code-mode"] as const)(
  "%s: defers both tools until promoted, keeps the promoted one direct, and needs the runner opt-in",
  (mode) => {
    const fresh = surface(mode);
    expect([heavy(fresh.sent), heavy(fresh.catalog)]).toEqual([[], ["computer", "github_publish"]]);
    const promoted = surface(mode, { promoted: ["computer"] });
    expect([heavy(promoted.sent), heavy(promoted.catalog)]).toEqual([
      ["computer"],
      ["github_publish"],
    ]);
    expect(promoted.catalogRef.directOnlyToolNames?.has("computer")).toBe(true);
    const plain = surface(mode, { loads: false });
    expect([heavy(plain.sent), heavy(plain.catalog)]).toEqual([["computer", "github_publish"], []]);
  },
);

it("keeps on-demand tools out of a headless catalog, like direct-only tools", () => {
  const catalogRef = createToolSearchCatalogRef();
  refs.push(catalogRef);
  registerHeadlessToolSearchCatalog({ catalogRef, tools: targets() });
  expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["read"]);
});

it("loads it when looked up or refused, and refuses dispatch_action and Code Mode guest calls", async () => {
  const tools = surface("tools");
  const loaded: string[] = [];
  tools.catalogRef.loadOnDemandTool = (name) => loaded.push(name);
  const control = (name: string) => tools.tools.find((tool) => tool.name === name)!;
  const search = await control("tool_search").execute("search", { query: "computer desktop" });
  expect(JSON.stringify(search.content)).toContain("loads as a top-level tool once looked up");
  expect(loaded).toEqual([]);
  await control("tool_describe").execute("describe", { id: "computer" });
  expect(loaded).toEqual(["computer"]);
  await expect(
    control("dispatch_action").execute("call", { id: "computer", args: { action: "screenshot" } }),
  ).rejects.toThrow("computer is now loaded as a top-level tool for this session. Call computer");
  expect(loaded).toEqual(["computer", "computer"]);
  // Without a loading runner the refusal still names the direct call.
  const refusal = "computer runs only as its own top-level tool call. Call computer directly";
  const code = surface("code-mode").tools.find((tool) => tool.name === "exec")!;
  const guest = await code.execute("cell", {
    code: "try { await computer({ action: 'screenshot' }); } catch (error) { return error.message; }",
    awaitResults: true,
  });
  expect(JSON.stringify(guest.details)).toContain(refusal);
  // Prompt directories and the Code Mode index mark them and exempt them from dispatch_action.
  for (const [mode, rule] of [
    ["tools", "Other names are not directly callable: call dispatch_action"],
    ["directory", "Call a unique other name directly, or dispatch_action"],
  ] as const) {
    const prompt = buildToolSchemaDirectoryPrompt({
      config: { tools: { toolSearch: { mode } } },
      catalogRef: surface(mode).catalogRef,
    });
    expect(prompt.split("\n")[0]).toContain("computer [loads on lookup]");
    expect(prompt).toContain(
      "Tools marked [loads on lookup] become top-level after tool_describe; call them only by name.",
    );
    expect(prompt).toContain(rule);
  }
  const { catalogRef } = surface("code-mode");
  expect(buildCodeModeCatalogPrompt({ catalogRef }, catalogRef.current!.entries)).toMatch(
    /- computer .*\[top-level call only; not from exec\]/,
  );
});
