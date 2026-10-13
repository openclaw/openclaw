/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
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
      agents={[
        { id: "main", name: "Main agent" },
        { id: "writer", name: "Writer" },
      ]}
      selection={createSelection(vi.fn())}
      {...overrides}
    />
  ));
  flush();
  const select = container.querySelector<AgentSelectElement>("openclaw-agent-select");
  await select?.updateComplete;
  return { container, select };
}

describe("AgentScopeControl", () => {
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

    setAgents([
      { id: "main", name: "Main agent" },
      { id: "writer", name: "Writer" },
    ]);
    flush();
    expect(container.querySelector(".agent-scope-control")).not.toBeNull();
  });

  it("includes historical agent ids and maps All agents back to null", async () => {
    const setScope = vi.fn();
    const { container, select } = await mountScope({
      agents: [
        { id: "main", name: "Main agent", identity: { emoji: "🦞" } },
        { id: "writer", name: "Writer" },
      ],
      additionalAgentIds: ["retired"],
      selection: createSelection(setScope),
    });
    expect(select).not.toBeNull();
    expect(select?.options.map((option) => option.value)).toEqual([
      "",
      "main",
      "retired",
      "writer",
    ]);
    expect(select?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe("🦞");

    select?.onSelect("retired");
    select?.onSelect("");
    expect(setScope).toHaveBeenNthCalledWith(1, "retired");
    expect(setScope).toHaveBeenNthCalledWith(2, null);
    container.remove();
  });

  it("keeps semantic system agents out of roster and historical options", async () => {
    const { container, select } = await mountScope({
      agents: [
        { id: "main", kind: "agent", name: "Main agent" },
        { id: "ordinary-looking-id", kind: "system", name: "System" },
        { id: "writer", kind: "agent", name: "Writer" },
      ],
      additionalAgentIds: ["ordinary-looking-id", "retired"],
      selectedId: "ordinary-looking-id",
    });
    expect(select?.value).toBe("");
    expect(select?.options.map((option) => option.value)).toEqual([
      "",
      "main",
      "retired",
      "writer",
    ]);
    container.remove();
  });

  it("uses the first selectable agent when a concrete selector receives a system id", async () => {
    const { container, select } = await mountScope({
      agents: [
        { id: "main", kind: "agent", name: "Main agent" },
        { id: "ordinary-looking-id", kind: "system", name: "System" },
        { id: "writer", kind: "agent", name: "Writer" },
      ],
      allowAll: false,
      selectedId: "ordinary-looking-id",
    });
    expect(select?.value).toBe("main");
    expect(select?.options.map((option) => option.value)).toEqual(["main", "writer"]);
    container.remove();
  });

  it("supports a concrete-agent selector without an all-agents option", async () => {
    const set = vi.fn();
    const selection = createSelection(vi.fn());
    selection.set = set;

    const { container, select } = await mountScope({
      selection,
      allowAll: false,
      selectedId: "writer",
    });
    expect(select?.value).toBe("writer");
    expect(select?.options.map((option) => option.value)).toEqual(["main", "writer"]);
    select?.onSelect("main");
    expect(set).toHaveBeenCalledWith("main");
    container.remove();
  });
});
