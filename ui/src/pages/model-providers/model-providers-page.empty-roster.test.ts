/* @vitest-environment jsdom */

import { afterEach, expect, it } from "vitest";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { appendPage, createHarness } from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
});

it.each(["empty", "system-only"] as const)(
  "finishes loading with a %s roster and keeps global defaults editable without scoped requests",
  async (rosterKind) => {
    const { context, request, runtimeConfig } = createHarness("main");
    context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: rosterKind === "empty" ? [] : [{ id: "main", kind: "system" }],
    };
    const selection = createAgentSelectionCapability(
      context.gateway,
      context.agents,
      undefined,
      undefined,
      { requireConfiguredAgent: true },
    );
    Object.assign(context, { settingsAgentSelection: selection });
    const page = appendPage(context);
    try {
      await runtimeConfig.ensureLoaded();
      await page.updateComplete;
      expect(selection.state.selectedId).toBeNull();
      expect(page.querySelector(".settings-loading-skeleton")).toBeNull();
      expect(page.textContent).toContain("No agents");
      expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(true);

      const groups = page.querySelectorAll<HTMLElement & { disabled: boolean; value: string }>(
        ".model-providers__defaults wa-radio-group",
      );
      expect(groups).toHaveLength(2);
      expect(groups[0]!.disabled).toBe(false);
      groups[0]!.value = "high";
      groups[0]!.dispatchEvent(new Event("change", { bubbles: true }));
      await waitForFast(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
      expect(runtimeConfig.patch).toHaveBeenCalledWith({
        raw: {
          agents: {
            defaults: {
              fastModeDefault: "auto",
              thinkingDefault: "high",
              utilityModel: null,
            },
          },
        },
        note: "Update defaults from Control UI",
        replacePaths: ["agents.defaults.model.fallbacks"],
      });
      expect(request.mock.calls.some(([method]) => method.startsWith("models."))).toBe(false);
    } finally {
      page.remove();
      selection.dispose();
    }
  },
);
