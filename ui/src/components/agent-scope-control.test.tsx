/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import type { AgentSelectionCapability } from "../app/agent-selection.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { AgentScopeControl } from "./agent-scope-control.tsx";
import type { AgentSelectElement } from "./agent-select.tsx";

function createSelection(setScope = vi.fn(), set = vi.fn()) {
  return {
    state: { selectedId: "main", scopeId: null },
    set,
    setScope,
    subscribe: vi.fn(),
  } as unknown as AgentSelectionCapability;
}

async function mountScope(overrides: Partial<Parameters<typeof AgentScopeControl>[0]> = {}) {
  const { container } = mountSolid(() => (
    <AgentScopeControl agents={configuredAgents} selection={createSelection()} {...overrides} />
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
    <AgentScopeControl agents={agents()} selection={createSelection()} />
  ));
  flush();
  expect(container.querySelector(".agent-scope-control")).toBeNull();

  setAgents([configuredAgents[0]!]);
  flush();
  expect(container.querySelector(".agent-scope-control")).toBeNull();

  setAgents(configuredAgents);
  flush();
  expect(container.querySelector(".agent-scope-control")).not.toBeNull();
});

it.each([true, false])("routes selection with allowAll=%s", async (allowAll) => {
  const selection = createSelection();
  const select = await mountScope({
    agents: [{ ...configuredAgents[0]!, identity: { emoji: "🦞" } }, configuredAgents[1]!],
    additionalAgentIds: allowAll ? ["retired"] : undefined,
    selection,
    allowAll,
    selectedId: allowAll ? undefined : "writer",
  });
  expect(values(select)).toEqual(allowAll ? ["", "main", "retired", "writer"] : ["main", "writer"]);
  if (allowAll) {
    expect(select?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe("🦞");
    select?.onSelect("retired");
    select?.onSelect("");
    expect(vi.mocked(selection.setScope).mock.calls).toEqual([["retired"], [null]]);
  } else {
    expect(select?.value).toBe("writer");
    select?.onSelect("main");
    expect(selection.set).toHaveBeenCalledWith("main");
  }
});

it.each([true, false])("excludes system agents with allowAll=%s", async (allowAll) => {
  const select = await mountScope({
    agents: systemAgents,
    additionalAgentIds: allowAll ? ["ordinary-looking-id", "retired"] : undefined,
    selectedId: "ordinary-looking-id",
    allowAll,
  });
  expect(select?.value).toBe(allowAll ? "" : "main");
  expect(values(select)).toEqual(allowAll ? ["", "main", "retired", "writer"] : ["main", "writer"]);
});
