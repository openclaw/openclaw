// Tools that poll by design stay direct under Tool Search, so the repeat guard reads their
// own `repeatable` declaration instead of dispatch_action's. Their catalog family follows
// them: a split family reads as the whole capability and hides the deferred member.
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { captureAgent, makeCall } from "../../packages/agent-core/src/agent-loop.test-support.js";
import {
  TOOL_REPEAT_LIMIT_CODE,
  TOOL_REPEAT_STOP_AT,
} from "../../packages/agent-core/src/tool-repeat-guard.js";
import { CORE_TOOL_DEFINITIONS } from "./core-tool-facts.js";
import { createReadTool } from "./sessions/tools/read.js";
import { createDirectVisibleCatalogTool } from "./tool-search-catalog.js";
import type { ToolSearchCatalogRef } from "./tool-search-types.js";
import {
  applyToolSchemaDirectoryCatalog,
  applyToolSearchCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
} from "./tool-search.js";
import { createAgentsWaitTool } from "./tools/agents-wait-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";

const refs: ToolSearchCatalogRef[] = [];
afterEach(() => {
  refs.splice(0).forEach((catalogRef) => clearToolSearchCatalog({ catalogRef }));
});

const answer = [{ type: "text" as const, text: "done" }];
const turns = (count: number, name: string, args: Record<string, unknown>) =>
  Array.from({ length: count }, (_, index) => [
    { ...makeCall(name, `${name}-${index}`), arguments: args },
  ]);

function surface(mode: "tools" | "directory", executed: string[] = []) {
  const catalogRef = createToolSearchCatalogRef();
  refs.push(catalogRef);
  const ctx = { config: { tools: { toolSearch: { mode } } }, catalogRef };
  const record = (name: string) => async () => {
    executed.push(name);
    return { content: [{ type: "text" as const, text: `${name} ok` }], details: {} };
  };
  // The real declaration and schema; only the run lifecycle is replaced.
  const agentsWait: AnyAgentTool = { ...createAgentsWaitTool({}), execute: record("agents_wait") };
  const lookup: AnyAgentTool = {
    name: "lookup",
    label: "Lookup",
    description: "Look up one record.",
    parameters: Type.Object({}),
    execute: record("lookup"),
  };
  const { tools } = (mode === "tools" ? applyToolSearchCatalog : applyToolSchemaDirectoryCatalog)({
    ...ctx,
    tools: [
      ...createToolSearchTools(ctx),
      createReadTool("/tmp/repeatable"),
      agentsWait,
      createSubagentsTool(),
      createSessionsSpawnTool({ config: {} }),
      lookup,
    ],
  });
  return { tools, sent: tools.map((tool) => tool.name) };
}

it.each(["tools", "directory"] as const)(
  "%s: keeps polling tools and their delegation family in the provider tool list and defers the rest",
  (mode) => {
    const { sent } = surface(mode);
    expect(sent).toEqual(expect.arrayContaining(["agents_wait", "subagents", "sessions_spawn"]));
    expect(sent).not.toContain("lookup");
  },
);

const familyMembers = Map.groupBy(
  CORE_TOOL_DEFINITIONS.filter((tool) => tool.catalogFamily),
  (tool) => tool.catalogFamily,
);

it.each([...familyMembers])("the %s family always has one visibility", (_family, members) => {
  const stub = (name: string, repeatable?: true): AnyAgentTool => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    ...(repeatable ? { repeatable } : {}),
    execute: async () => ({ content: [], details: {} }),
  });
  const names = members.map((member) => member.id);
  // No member visible, each member polling, and each member required by the caller.
  const cases = [
    { polling: undefined, required: [] },
    ...names.map((name) => ({ polling: name, required: [] })),
    ...names.map((name) => ({ polling: undefined, required: [name] })),
  ];
  for (const { polling, required } of cases) {
    const tools = names.map((name) => stub(name, name === polling ? true : undefined));
    const visible = createDirectVisibleCatalogTool(tools, new Set(required));
    expect(tools.map(visible)).toEqual(
      names.map(() => polling !== undefined || required.length > 0),
    );
  }
});

it("lets 25 identical agents_wait polls run with no note and no stop", async () => {
  const executed: string[] = [];
  const { agent } = captureAgent(surface("tools", executed).tools, {}, [
    ...turns(25, "agents_wait", { ids: ["child-1"], timeoutSeconds: 30 }),
    answer,
  ]);

  await agent.prompt("start");

  expect(executed).toEqual(Array.from({ length: 25 }, () => "agents_wait"));
  expect(JSON.stringify(agent.state.messages)).not.toContain("[System note:");
  expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
});

it("still stops a non-repeatable target repeated through dispatch_action at the twentieth call", async () => {
  const executed: string[] = [];
  const { agent } = captureAgent(surface("tools", executed).tools, {}, [
    ...turns(TOOL_REPEAT_STOP_AT, "dispatch_action", { id: "lookup", args: {} }),
    answer,
  ]);

  await agent.prompt("start");

  expect(executed).toEqual(Array.from({ length: TOOL_REPEAT_STOP_AT - 1 }, () => "lookup"));
  expect(agent.state.messages.at(-1)).toMatchObject({
    role: "assistant",
    stopReason: "error",
    errorCode: TOOL_REPEAT_LIMIT_CODE,
  });
});
