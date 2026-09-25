import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

describe("renderAgents toolbar", () => {
  it.each([0, 1, 2])("keeps standalone agent creation available with %i agents", (count) => {
    const container = document.createElement("div");
    const onCreateAgent = vi.fn();
    render(
      renderAgents(
        createProps({
          agentsList: {
            defaultId: "alpha",
            mainKey: "main",
            scope: "per-sender",
            agents: [
              { id: "alpha", name: "Alpha" },
              { id: "beta", name: "Beta" },
            ].slice(0, count),
          },
          selectedAgentId: "alpha",
          onCreateAgent,
        }),
      ),
      container,
    );

    expect(container.querySelector("openclaw-agent-select")).toBeNull();
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
      expect(container.querySelector("openclaw-agent-select")).toBeNull();
      expect(container.querySelector(".agents-create-btn")).toBeNull();
      expect(onCreateAgent).not.toHaveBeenCalled();
    } finally {
      container.remove();
    }
  });
});
