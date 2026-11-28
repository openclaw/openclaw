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

// Real declarations and schemas; only the run lifecycle is replaced.
const familyFactories: Record<string, () => AnyAgentTool> = {
  agents_wait: () => createAgentsWaitTool({}),
  sessions_spawn: () => createSessionsSpawnTool({ config: {} }),
  subagents: () => createSubagentsTool(),
};
const delegationFamily: string[] = CORE_TOOL_DEFINITIONS.filter(
  (tool) => tool.catalogFamily === "delegation",
).map((tool) => tool.id);

function surface(
  mode: "tools" | "directory",
  executed: string[] = [],
  members: readonly string[] = delegationFamily,
  include?: Array<{ name: string }>,
) {
  const catalogRef = createToolSearchCatalogRef();
  refs.push(catalogRef);
  const ctx = {
    config: { tools: { toolSearch: { mode, ...(include ? { include } : {}) } } },
    catalogRef,
  };
  const record = (name: string) => async () => {
    executed.push(name);
    return { content: [{ type: "text" as const, text: `${name} ok` }], details: {} };
  };
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
      // The family test asserts every member has a factory.
      ...members.flatMap((name) => {
        const create = familyFactories[name];
        return create ? [{ ...create(), execute: record(name) }] : [];
      }),
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

it.each(["tools", "directory"] as const)(
  "%s: the delegation family always has one visibility",
  (mode) => {
    expect(Object.keys(familyFactories).toSorted()).toEqual(delegationFamily.toSorted());
    // Every non-empty subset a tool policy can leave enabled, with and without a selector
    // that keeps the other members outside the catalog.
    const subsets = Array.from({ length: 2 ** delegationFamily.length - 1 }, (_, index) =>
      delegationFamily.filter((_name, bit) => ((index + 1) >> bit) & 1),
    );
    for (const include of [undefined, ...delegationFamily.map((name) => [{ name }])]) {
      for (const members of subsets) {
        const sent = surface(mode, [], members, include).sent.filter((name) =>
          members.includes(name),
        );
        expect([0, members.length]).toContain(sent.length);
      }
    }
    // With no polling member left, the spawner stays deferred.
    expect(surface(mode, [], ["sessions_spawn"]).sent).not.toContain("sessions_spawn");
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
