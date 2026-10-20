/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import type { AgentSelectionCapability } from "../app/agent-selection.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { AgentScopeControl } from "./agent-scope-control.tsx";
import type { AgentSelectOption } from "./agent-select.ts";

type AgentSelectElement = HTMLElement & {
  options: AgentSelectOption[];
  value: string;
  onSelect: (value: string) => void;
  updateComplete: Promise<boolean>;
};

function createSelection(setScope: (agentId: string | null) => void) {
  return {
    state: { selectedId: "main", scopeId: null },
    set: vi.fn(),
    setScope,
    subscribe: vi.fn(),
  } as unknown as AgentSelectionCapability;
}

async function mountScope(overrides: Partial<Parameters<typeof AgentScopeControl>[0]> = {}) {
  const { container } = mountSolid(() => (
    <AgentScopeControl
      agents={configuredAgents}
      selection={createSelection(vi.fn())}
      {...overrides}
    />
  ));
  flush();
  const select = container.querySelector<AgentSelectElement>("openclaw-agent-select");
  await select?.updateComplete;
  return select;
}

const configuredAgents = [
  { id: "main", name: "Main agent" },
  { id: "writer", name: "Writer" },
];
const systemAgents = [
  ...configuredAgents.map((agent) => ({ ...agent, kind: "agent" as const })),
  { id: "ordinary-looking-id", kind: "system" as const, name: "System" },
];
const values = (select: AgentSelectElement | null) => select?.options.map((option) => option.value);

it("renders only when multiple configured agents are selectable", () => {
  const [agents, setAgents] = createSignal<Array<{ id: string; name: string }>>([]);
  const { container } = mountSolid(() => (
    <AgentScopeControl agents={agents()} selection={createSelection(vi.fn())} />
  ));
  flush();
  expect(container.querySelector(".agent-scope-control")).toBeNull();

  setAgents([{ id: "main", name: "Main agent" }]);
  flush();
  expect(container.querySelector(".agent-scope-control")).toBeNull();

  setAgents(configuredAgents);
  flush();
  expect(container.querySelector(".agent-scope-control")).not.toBeNull();
});

it("includes historical agent ids and maps All agents back to null", async () => {
  const setScope = vi.fn();
  const select = await mountScope({
    agents: [{ ...configuredAgents[0]!, identity: { emoji: "🦞" } }, configuredAgents[1]!],
    additionalAgentIds: ["retired"],
    selection: createSelection(setScope),
  });
  expect(select).not.toBeNull();
  expect(values(select)).toEqual(["", "main", "retired", "writer"]);
  expect(select?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe("🦞");

  select?.onSelect("retired");
  select?.onSelect("");
  expect(setScope).toHaveBeenNthCalledWith(1, "retired");
  expect(setScope).toHaveBeenNthCalledWith(2, null);
});

it("keeps semantic system agents out of roster and historical options", async () => {
  const select = await mountScope({
    agents: systemAgents,
    additionalAgentIds: ["ordinary-looking-id", "retired"],
    selectedId: "ordinary-looking-id",
  });
  expect(select?.value).toBe("");
  expect(values(select)).toEqual(["", "main", "retired", "writer"]);
});

it("uses the first selectable agent when a concrete selector receives a system id", async () => {
  const select = await mountScope({
    agents: systemAgents,
    allowAll: false,
    selectedId: "ordinary-looking-id",
  });
  expect(select?.value).toBe("main");
  expect(values(select)).toEqual(["main", "writer"]);
});

it("supports a concrete-agent selector without an all-agents option", async () => {
  const set = vi.fn();
  const selection = createSelection(vi.fn());
  selection.set = set;

  const select = await mountScope({
    selection,
    allowAll: false,
    selectedId: "writer",
  });
  expect(select?.value).toBe("writer");
  expect(values(select)).toEqual(["main", "writer"]);
  select?.onSelect("main");
  expect(set).toHaveBeenCalledWith("main");
});
