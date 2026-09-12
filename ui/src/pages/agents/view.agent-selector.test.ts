// Control UI tests cover agent-selector behavior.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AgentSelect } from "../../components/agent-select.ts";
import { t } from "../../i18n/index.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

describe("renderAgents agent selector", () => {
  it.each([0, 1])("keeps standalone agent creation available with %i agents", (count) => {
    const container = document.createElement("div");
    const onCreateAgent = vi.fn();
    render(
      renderAgents(
        createProps({
          agentsList: {
            defaultId: "alpha",
            mainKey: "main",
            scope: "per-sender",
            agents: count === 0 ? [] : [{ id: "alpha", name: "Alpha" }],
          },
          selectedAgentId: "alpha",
          onCreateAgent,
        }),
      ),
      container,
    );

    expect(container.querySelector(".agents-control-select")).toBeNull();
    const createButton = container.querySelector<HTMLButtonElement>(".agents-create-btn");
    expect(createButton?.textContent?.trim()).toBe(t("custodian.newAgent"));
    createButton?.click();
    expect(onCreateAgent).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 2])("preserves creation permission gating with %i agents", async (count) => {
    const container = document.createElement("div");
    document.body.append(container);
    const onCreateAgent = vi.fn();
    const defaults = createProps();
    try {
      render(
        renderAgents(
          createProps({
            agentsList: {
              defaultId: "alpha",
              mainKey: "main",
              scope: "per-sender",
              agents: [{ id: "alpha" }, { id: "beta" }].slice(0, count),
            },
            access: { ...defaults.access, canCreateAgent: false },
            onCreateAgent,
          }),
        ),
        container,
      );
      const select = container.querySelector<AgentSelect>("openclaw-agent-select");
      await select?.updateComplete;
      expect(container.querySelector(".agents-create-btn")).toBeNull();
      expect(container.querySelector("[data-create-agent]")).toBeNull();
      if (count > 1) {
        expect(select).not.toBeNull();
        expect(select?.onCreateAgent).toBeNull();
        expect(select?.querySelectorAll("[data-agent-option]")).toHaveLength(count);
      }
      expect(onCreateAgent).not.toHaveBeenCalled();
    } finally {
      container.remove();
    }
  });

  it("keeps deliberate creation in the multi-agent selector footer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onCreateAgent = vi.fn();
    const onSelectAgent = vi.fn();
    try {
      render(renderAgents(createProps({ onCreateAgent, onSelectAgent })), container);
      const select = container.querySelector<AgentSelect>("openclaw-agent-select");
      await select?.updateComplete;
      expect(container.querySelector(".agents-create-btn")).toBeNull();
      const footer = select?.querySelector<HTMLElement>("[data-create-agent]");
      expect(footer?.textContent?.trim()).toBe(t("custodian.newAgent"));
      footer?.click();
      expect(onCreateAgent).toHaveBeenCalledOnce();
      expect(onSelectAgent).not.toHaveBeenCalled();
    } finally {
      container.remove();
    }
  });

  it("groups agent-created children while leaving provenance-free and dangling rows unchanged", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const main = { id: "main", name: "Main" };
    const orphan = { id: "orphan", name: "Orphan" };
    const research = { id: "research", name: "Research" };
    const baseAgents = [main, orphan, research];

    try {
      render(
        renderAgents(
          createProps({
            agentsList: {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: baseAgents,
            },
            selectedAgentId: "main",
          }),
        ),
        container,
      );
      const select = container.querySelector("openclaw-agent-select") as
        | (HTMLElement & {
            options: Array<{
              value: string;
              description?: string;
            }>;
            updateComplete: Promise<boolean>;
          })
        | null;
      await select?.updateComplete;

      expect(select?.options).toMatchObject([
        { value: "main" },
        { value: "orphan" },
        { value: "research" },
      ]);
      expect(select?.options.every((option) => !option.description)).toBe(true);
      expect(select?.querySelector(".agent-select__option-description")).toBeNull();

      render(
        renderAgents(
          createProps({
            agentsList: {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                { ...main, createdVia: "operator", creatorAgentId: null, createdAt: 1 },
                {
                  ...orphan,
                  createdVia: "agent",
                  creatorAgentId: "deleted",
                  createdAt: 2,
                },
                {
                  ...research,
                  createdVia: "agent",
                  creatorAgentId: "main",
                  createdAt: 3,
                },
              ],
            },
            selectedAgentId: "main",
          }),
        ),
        container,
      );
      await select?.updateComplete;

      const createdByMain = t("agents.createdBy", { id: "main" });
      expect(select?.options).toMatchObject([
        { value: "main" },
        { value: "research", description: createdByMain },
        { value: "orphan" },
      ]);
      const rows = select?.querySelectorAll("wa-dropdown-item[data-agent-option]") ?? [];
      expect(rows[1]?.querySelector(".agent-select__option-description")?.textContent?.trim()).toBe(
        createdByMain,
      );
      expect(rows[2]?.querySelector(".agent-select__option-description")).toBeNull();
    } finally {
      container.remove();
    }
  });
});
