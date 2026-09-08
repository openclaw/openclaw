import { nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import "../../styles.css";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { createProps, createSkill } from "./view.test-support.ts";
import { renderSkills } from "./view.ts";

const browserMode = "__vitest_browser__" in globalThis;
let container: HTMLElement | undefined;

afterEach(() => {
  if (container) {
    render(nothing, container);
    container.remove();
  }
});

describe.runIf(browserMode)("skill reader shell", () => {
  it.each(
    [390, 1440].flatMap((width) => ["error", "installed"].map((variant) => ({ width, variant }))),
  )("sizes $variant content within the viewport at $width px", async ({ width, variant }) => {
    const { page, userEvent } = await import("vitest/browser");
    await page.viewport(width, 844);
    container = document.createElement("openclaw-skills-page");
    document.body.append(container);
    const showContent = (content: string) => {
      render(
        renderSkills(
          createProps(
            variant === "error"
              ? { clawhubDetailRef: "example-skill", clawhubDetailError: content }
              : {
                  detailKey: "repo-skill",
                  report: {
                    workspaceDir: "/fixture/workspace",
                    managedSkillsDir: "/fixture/skills",
                    skills: [createSkill({ description: content, primaryEnv: undefined })],
                  },
                },
          ),
        ),
        container!,
      );
    };
    const shortContent = "Read the source and report actionable findings.";
    showContent(shortContent);
    const { modal, dialog } = await getRenderedModalDialog(container);
    await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
    const title = container.querySelector<HTMLElement>(".md-preview-dialog__title")!;
    const close = container.querySelector<HTMLButtonElement>(".md-preview-dialog__header button")!;
    const panel = container.querySelector<HTMLElement>(".md-preview-dialog__panel")!;
    const titleRect = title.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    expect(closeRect.top).toBeLessThan(titleRect.bottom);
    expect(closeRect.left).toBeGreaterThanOrEqual(titleRect.right);
    expect(panel.getBoundingClientRect().height).toBeLessThan(window.innerHeight / 2);
    expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(modal.label).toBe(variant === "error" ? "example-skill" : "Repo Skill");

    showContent(shortContent.repeat(200));
    const body = panel.querySelector<HTMLElement>(".md-preview-dialog__body")!;
    await expect.poll(() => body.scrollHeight > body.clientHeight).toBe(true);
    expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    const headerTop = close.getBoundingClientRect().top;
    body.scrollTop = body.scrollHeight;
    expect(body.scrollTop).toBeGreaterThan(0);
    expect(close.getBoundingClientRect().top).toBe(headerTop);

    showContent(shortContent);
    await expect
      .poll(() => panel.getBoundingClientRect().height)
      .toBeLessThan(window.innerHeight / 2);
    expect(body.scrollHeight).toBe(body.clientHeight);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => dialog.open).toBe(false);
  });
});
