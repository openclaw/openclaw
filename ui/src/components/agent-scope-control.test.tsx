/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import type { GatewayAgentRow } from "../api/types.ts";
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

it("skips unchanged scope inputs while keeping roster and selection changes live", async () => {
  const name = vi.fn(() => "Main agent");
  const selection = createSelection();
  const agents: GatewayAgentRow[] = [
    {
      id: "main",
      get name() {
        return name();
      },
    },
    configuredAgents[1]!,
  ];
  const [inputs, setInputs] = createSignal({
    agents,
    additionalAgentIds: ["retired"],
    selectedId: "main",
    allowAll: true,
  });
  const { container } = mountSolid(() => <AgentScopeControl {...inputs()} selection={selection} />);
  flush();
  const select = container.querySelector<AgentSelectElement>("openclaw-agent-select")!;
  await select.updateComplete;
  name.mockClear();
  for (let i = 0; i < 5; i++) {
    setInputs((previous) => ({ ...previous }));
    flush();
    await select.updateComplete;
  }
  expect(name).not.toHaveBeenCalled();
  expect(values(select)).toEqual(["", "main", "retired", "writer"]);

  const update = async (patch: Partial<ReturnType<typeof inputs>>) => {
    setInputs((previous) => ({ ...previous, ...patch }));
    flush();
    await select.updateComplete;
  };
  await update({ selectedId: "writer" });
  expect(select.value).toBe("writer");
  await update({ allowAll: false });
  expect(values(select)).toEqual(["main", "retired", "writer"]);
  select.onSelect("main");
  expect(selection.set).toHaveBeenCalledWith("main");
  await update({ additionalAgentIds: ["historical"] });
  expect(values(select)).toEqual(["historical", "main", "writer"]);
  await update({ agents: [{ id: "main", name: "Zebra" }, configuredAgents[1]!] });
  expect(select.options.map((option) => option.label)).toEqual(["historical", "Writer", "Zebra"]);
  await update({
    agents: [{ id: "main", name: "Zebra", identity: { emoji: "🐙" } }, configuredAgents[1]!],
  });
  expect(
    select.querySelector('[value="main"] .identity-avatar__text')?.getAttribute("data-avatar"),
  ).toBe("🐙");
  await update({ agents: [...inputs().agents, { id: "new", name: "New" }] });
  expect(values(select)).toEqual(["historical", "new", "writer", "main"]);
  await update({ selectedId: "selected-history" });
  expect(select.value).toBe("selected-history");
  expect(values(select)).toContain("selected-history");
  await update({ agents: inputs().agents.filter((agent) => agent.id !== "writer") });
  expect(values(select)).not.toContain("writer");
});
