/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderSkillWorkshopHeaderControls } from "./header-controls.ts";
import { createSkillWorkshopState } from "./proposals.ts";
import { resolveSelfLearning } from "./self-learning.ts";
import { createContext, createRuntimeConfigStub } from "./skill-workshop-page.test-support.ts";

describe("skill workshop header tabs", () => {
  it("renders Skills by default and reports the requested section", () => {
    const state = createSkillWorkshopState();
    const onModeChange = vi.fn();
    const container = document.createElement("div");
    render(
      renderSkillWorkshopHeaderControls(state, {
        selfLearning: null,
        automationHref: "/settings/automation?section=cron",
        onSelfLearningToggle: () => undefined,
        onModeChange,
      }),
      container,
    );

    expect(container.querySelector("#skill-workshop-mode-tab-skills")?.hasAttribute("active")).toBe(
      true,
    );
    container
      .querySelector("#skill-workshop-mode-tab-suggestions")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));

    expect(onModeChange).toHaveBeenCalledWith("suggestions");
  });

  it.each([
    ["cron disabled", { cron: { enabled: false } }, false, true],
    ["refreshing a disabled-cron snapshot", { cron: { enabled: false } }, true, false],
    ["cron enabled", { cron: { enabled: true } }, false, false],
    ["default cron", {}, false, false],
    [
      "propose mode with cron disabled",
      { cron: { enabled: false }, skills: { workshop: { autonomous: { mode: "propose" } } } },
      false,
      false,
    ],
    [
      "propose mode with cron enabled",
      { cron: { enabled: true }, skills: { workshop: { autonomous: { mode: "propose" } } } },
      false,
      false,
    ],
    [
      "self-learning off",
      { cron: { enabled: false }, skills: { workshop: { autonomous: { mode: "off" } } } },
      false,
      false,
    ],
    ["config not loaded", null, false, false],
  ] as const)("explains weekly review availability with %s", (_name, config, loading, paused) => {
    const container = document.createElement("div");
    const onSelfLearningToggle = vi.fn();
    const automationHref = "/control/settings/automation?section=cron";
    const runtimeConfig = createRuntimeConfigStub({ sourceConfig: config ?? undefined });
    runtimeConfig.state.configLoading = loading;
    const context = createContext(vi.fn(), { runtimeConfig });
    render(
      renderSkillWorkshopHeaderControls(createSkillWorkshopState(), {
        selfLearning: resolveSelfLearning(context.runtimeConfig, false, null, true),
        automationHref,
        onSelfLearningToggle,
        onModeChange: () => undefined,
      }),
      container,
    );
    const warning = container.querySelector(".sw-self-learning-warning");
    expect(warning !== null).toBe(paused);
    if (paused) {
      expect(warning?.textContent).toContain(
        "Weekly reviews paused. Enable cron in Automation settings.",
      );
      const link = warning?.querySelector("a");
      expect(link?.getAttribute("href")).toBe(automationHref);
      link?.addEventListener("click", (event) => event.preventDefault());
      link?.click();
      expect(onSelfLearningToggle).not.toHaveBeenCalled();
      const toggle = container.querySelector<HTMLInputElement>("input[type='checkbox']");
      expect(toggle?.checked).toBe(true);
      expect(toggle?.disabled).toBe(false);
    }
  });
});
