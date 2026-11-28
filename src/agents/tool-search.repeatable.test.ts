// Tools that poll by design stay direct under Tool Search, so the repeat guard reads their
// own `repeatable` declaration instead of dispatch_action's.
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { captureAgent, makeCall } from "../../packages/agent-core/src/agent-loop.test-support.js";
import {
  TOOL_REPEAT_LIMIT_CODE,
  TOOL_REPEAT_STOP_AT,
} from "../../packages/agent-core/src/tool-repeat-guard.js";
import { createReadTool } from "./sessions/tools/read.js";
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
      lookup,
    ],
  });
  return { tools, sent: tools.map((tool) => tool.name) };
}

it.each(["tools", "directory"] as const)(
  "%s: keeps polling tools in the provider tool list and defers the rest",
  (mode) => {
    const { sent } = surface(mode);
    expect(sent).toEqual(expect.arrayContaining(["agents_wait", "subagents"]));
    expect(sent).not.toContain("lookup");
  },
);

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
