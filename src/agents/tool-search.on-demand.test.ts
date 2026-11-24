// On-demand tools stay out of the provider tool list until the session calls them by name.
import { afterEach, expect, it } from "vitest";
import { applyCodeModeCatalog } from "./code-mode.js";
import { createCodeModeHarness, resetCodeModeTestState } from "./code-mode.test-support.js";
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

it.each(["tools", "directory", "code-mode"] as const)(
  "%s: defers both tools until promoted, then keeps the promoted one direct",
  (mode) => {
    const fresh = surface(mode);
    expect(fresh.sent).not.toContain("computer");
    expect(fresh.sent).not.toContain("github_publish");
    expect(fresh.catalog).toEqual(expect.arrayContaining(["computer", "github_publish"]));
    const promoted = surface(mode, { promoted: ["computer"] });
    expect(promoted.sent).toContain("computer");
    expect(promoted.catalog).not.toContain("computer");
    expect(promoted.catalog).toContain("github_publish");
    expect(promoted.catalogRef.directOnlyToolNames?.has("computer")).toBe(true);
  },
);

it("keeps on-demand tools direct for a runner that cannot load them and in a headless catalog", () => {
  const plain = surface("tools", { loads: false });
  expect(plain.sent).toEqual(expect.arrayContaining(["computer", "github_publish"]));
  expect(plain.catalog).not.toContain("computer");
  const catalogRef = createToolSearchCatalogRef();
  refs.push(catalogRef);
  registerHeadlessToolSearchCatalog({ catalogRef, tools: targets() });
  expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["read"]);
});

it("tells the model to call it by name and refuses dispatch_action and Code Mode guest calls", async () => {
  const control = (name: string) => surface("tools").tools.find((tool) => tool.name === name)!;
  const search = await control("tool_search").execute("search", { query: "computer desktop" });
  expect(JSON.stringify(search.content)).toContain("top-level by name; not dispatch_action");
  const refusal = "computer runs only as its own top-level tool call. Call computer directly";
  await expect(
    control("dispatch_action").execute("call", { id: "computer", args: { action: "screenshot" } }),
  ).rejects.toThrow(refusal);
  const code = surface("code-mode").tools.find((tool) => tool.name === "exec")!;
  const guest = await code.execute("cell", {
    code: "try { await computer({ action: 'screenshot' }); } catch (error) { return error.message; }",
    awaitResults: true,
  });
  expect(JSON.stringify(guest.details)).toContain(refusal);
});
