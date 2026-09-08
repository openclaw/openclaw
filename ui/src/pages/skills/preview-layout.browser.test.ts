import { nothing, render } from "lit";
import { describe, expect, it } from "vitest";
import "../../styles.css";
import "../../styles/settings.css";
import "../../styles/plugins.css";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { createProps, createSkill } from "./view.test-support.ts";
import { renderSkills } from "./view.ts";

const browserMode = "__vitest_browser__" in globalThis;

describe.runIf(browserMode)("skill detail preview layout", () => {
  it.each([390, 768])("keeps long skill details inside the modal at %dpx", async (width) => {
    const { page, userEvent } = await import("vitest/browser");
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const container = document.createElement("openclaw-skills-page");
    container.className = "settings-page";
    document.body.append(container);
    await page.viewport(width, 844);
    try {
      render(
        renderSkills(
          createProps({
            detailKey: "repo-skill",
            report: {
              workspaceDir: "/synthetic/workspace",
              managedSkillsDir: "/synthetic/skills",
              skills: [createSkill({ description: "Long skill instructions. ".repeat(300) })],
            },
            onDetailClose: () => render(nothing, container),
          }),
        ),
        container,
      );
      const { dialog } = await getRenderedModalDialog(container);
      await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
      const panel = container.querySelector<HTMLElement>(".md-preview-dialog__panel")!;
      const body = container.querySelector<HTMLElement>(".md-preview-dialog__body")!;
      const close = container.querySelector<HTMLButtonElement>(
        ".md-preview-dialog__header button",
      )!;
      const bounds = dialog.getBoundingClientRect();
      const content = panel.getBoundingClientRect();
      expect(content.top).toBeGreaterThanOrEqual(bounds.top - 1);
      expect(content.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
      expect(content.bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(body.clientHeight).toBeGreaterThan(0);
      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
      const closeTop = close.getBoundingClientRect().top;
      body.scrollTop = body.scrollHeight;
      expect(body.scrollTop).toBeGreaterThan(0);
      expect(close.getBoundingClientRect().top).toBe(closeTop);
      await userEvent.click(close);
      expect(dialog.open).toBe(false);
    } finally {
      render(nothing, container);
      container.remove();
      await page.viewport(viewport.width, viewport.height);
    }
  });
});
