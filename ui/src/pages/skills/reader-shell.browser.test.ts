import { nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import "../../styles.css";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { renderConnectMachineDialog } from "../new-session/connect-machine-dialog.ts";
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
  it.each([390, 1440])("scrolls long Skill Card code inside its block at %i px", async (width) => {
    const { page } = await import("vitest/browser");
    await page.viewport(width, 844);
    container = document.createElement("openclaw-skills-page");
    document.body.append(container);
    const code = "display_sample_".repeat(18);
    render(
      renderSkills(
        createProps({
          detailKey: "repo-skill",
          detailTab: "card",
          report: {
            workspaceDir: "/fixture/workspace",
            managedSkillsDir: "/fixture/skills",
            skills: [
              createSkill({
                primaryEnv: undefined,
                skillCard: {
                  present: true,
                  path: "/fixture/skill-card.md",
                  sizeBytes: code.length,
                },
              }),
            ],
          },
          skillCardContents: {
            "repo-skill": `Read this ordinary paragraph without scrolling the reader sideways.\n\n\`\`\`text\n${code}\n\`\`\``,
          },
        }),
      ),
      container,
    );
    const { dialog } = await getRenderedModalDialog(container);
    await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
    const body = container.querySelector<HTMLElement>(".skill-reader-dialog__body")!;
    const pre = body.querySelector<HTMLPreElement>("pre")!;
    const paragraph = body.querySelector<HTMLParagraphElement>("article p")!;
    const tab = body.querySelector<HTMLElement>("#skill-detail-tab-card")!;
    expect(body.clientWidth).toBeGreaterThan(0);
    expect(body.scrollWidth).toBe(body.clientWidth);
    expect(paragraph.getBoundingClientRect().right).toBeLessThanOrEqual(
      body.getBoundingClientRect().right,
    );
    expect(pre.querySelector("code")?.textContent).toBe(`${code}\n`);
    expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
    const tabLeft = tab.getBoundingClientRect().left;
    pre.scrollLeft = 100;
    expect(pre.scrollLeft).toBeGreaterThan(0);
    body.scrollLeft = 100;
    expect(body.scrollLeft).toBe(0);
    expect(tab.getBoundingClientRect().left).toBe(tabLeft);
  });

  it.each(
    [390, 1440].flatMap((width) => ["error", "installed"].map((variant) => ({ width, variant }))),
  )("sizes $variant content within the viewport at $width px", async ({ width, variant }) => {
    const { page, userEvent } = await import("vitest/browser");
    await page.viewport(width, 844);
    container = document.createElement("openclaw-skills-page");
    document.body.append(container);
    render(
      renderConnectMachineDialog({
        open: true,
        loading: false,
        error: null,
        setup: null,
        onRefresh: () => undefined,
        onClose: () => undefined,
        onManageDevices: () => undefined,
      }),
      container,
    );
    const canonical = await getRenderedModalDialog(container);
    await Promise.all(canonical.dialog.getAnimations().map((animation) => animation.finished));
    const readChrome = (panel: HTMLElement) => {
      const style = getComputedStyle(panel);
      const close = panel.querySelector<HTMLButtonElement>("button")!;
      const button = getComputedStyle(close);
      const icon = getComputedStyle(close.querySelector("svg")!);
      return {
        surface: style.backgroundColor,
        image: style.backgroundImage,
        border: style.border,
        radius: style.borderRadius,
        button: [button.background, button.border, button.boxShadow],
        icon: [icon.width, icon.height, icon.strokeWidth],
      };
    };
    const canonicalChrome = readChrome(
      container.querySelector<HTMLElement>(".exec-approval-card")!,
    );
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
    const title = container.querySelector<HTMLElement>(
      ".skill-reader-dialog > :first-child > :first-child",
    )!;
    const close = container.querySelector<HTMLButtonElement>(
      ".skill-reader-dialog > :first-child button",
    )!;
    const panel = container.querySelector<HTMLElement>(".skill-reader-dialog")!;
    expect(readChrome(panel)).toEqual(canonicalChrome);
    const titleRect = title.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    expect(closeRect.top).toBeLessThan(titleRect.bottom);
    expect(closeRect.left).toBeGreaterThanOrEqual(titleRect.right);
    expect(panel.getBoundingClientRect().height).toBeLessThan(window.innerHeight / 2);
    expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(modal.label).toBe(variant === "error" ? "example-skill" : "Repo Skill");

    showContent(shortContent.repeat(200));
    const body = panel.querySelector<HTMLElement>(".skill-reader-dialog__body")!;
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
