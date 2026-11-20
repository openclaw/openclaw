import { afterEach, describe, expect, it } from "vitest";
import "../../styles.css";
import { finishElementAnimations } from "../../test-helpers/animations.ts";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { cleanupSkillsViews, renderSkills } from "./view.solid.test-support.tsx";
import { createProps, createReport, createSkill } from "./view.test-support.ts";

const browserMode = "__vitest_browser__" in globalThis;
let container: HTMLElement | undefined;

afterEach(() => {
  cleanupSkillsViews();
  container?.remove();
});

function createContainer() {
  container?.remove();
  container = document.createElement("openclaw-skills-page");
  document.body.append(container);
}

function showInstalled(skill: Parameters<typeof createSkill>[0], messages = {}) {
  renderSkills(
    createProps({ detailKey: "repo-skill", report: createReport([createSkill(skill)]), messages }),
    container!,
  );
}

async function settledDialog() {
  const result = await getRenderedModalDialog(container!);
  finishElementAnimations(result.dialog);
  return result;
}

const query = (selector: string, parent = container!) =>
  parent.querySelector<HTMLElement>(selector)!;

describe.runIf(browserMode)("skill reader shell", () => {
  it.each(
    [390, 1440].flatMap((width) => ["error", "installed"].map((variant) => ({ width, variant }))),
  )("sizes $variant content within the viewport at $width px", async ({ width, variant }) => {
    const { page, userEvent } = await import("vitest/browser");
    await page.viewport(width, 844);
    createContainer();
    const showContent = (content: string) =>
      variant === "error"
        ? renderSkills(
            createProps({ clawhubDetailRef: "example-skill", clawhubDetailError: content }),
            container!,
          )
        : showInstalled({ description: content, primaryEnv: undefined });
    const shortContent = "Read the source and report actionable findings.";
    showContent(shortContent);
    const { modal, dialog } = await settledDialog();
    const panel = query(".skill-reader-dialog");
    const title = query(":scope > :first-child > :first-child", panel);
    const close = query(":scope > :first-child button", panel);
    expect(panel.classList.contains("oc-dialog")).toBe(true);
    expect(close.classList.contains("oc-dialog__close")).toBe(true);
    expect(getComputedStyle(query(":scope > :first-child", panel)).borderBottomWidth).toBe("0px");
    const titleRect = title.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    expect(closeRect.top).toBeLessThan(titleRect.bottom);
    expect(closeRect.left).toBeGreaterThanOrEqual(titleRect.right);
    expect(panel.getBoundingClientRect().height).toBeLessThan(window.innerHeight / 2);
    expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(modal.label).toBe(variant === "error" ? "example-skill" : "Repo Skill");

    showContent(shortContent.repeat(200));
    const body = query(".skill-reader-dialog__body", panel);
    await expect.poll(() => body.scrollHeight > body.clientHeight).toBe(true);
    expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    const headerTop = close.getBoundingClientRect().top;
    body.scrollTop = body.scrollHeight;
    expect(body.scrollTop).toBeGreaterThan(0);
    expect(close.getBoundingClientRect().top).toBeCloseTo(headerTop, 2);

    showContent(shortContent);
    await expect
      .poll(() => panel.getBoundingClientRect().height)
      .toBeLessThan(window.innerHeight / 2);
    expect(body.scrollHeight).toBe(body.clientHeight);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => dialog.open).toBe(false);
  });
  it.each(["success", "error"] as const)(
    "keeps %s install feedback scrollable below the reachable header action in landscape",
    async (kind) => {
      const { page, userEvent } = await import("vitest/browser");
      await page.viewport(844, 390);
      createContainer();
      renderSkills(
        createProps({
          clawhubDetailRef: "@fixture/calendar",
          clawhubDetail: {
            skill: { slug: "calendar", displayName: "Calendar", createdAt: 1, updatedAt: 2 },
          },
          clawhubInstallMessage: {
            ref: "@fixture/calendar",
            kind,
            text: "REVIEW RECOMMENDED — inspect this release before use.\n".repeat(24),
          },
        }),
        container!,
      );
      const { dialog } = await settledDialog();
      const panel = query(".skill-reader-dialog");
      const notice = query(".skill-reader-dialog__notice", panel);
      const body = query(".skill-reader-dialog__body", panel);
      // The skill page keeps its one action in the header, outside the scroller.
      const actions = query(".skill-page__actions", panel);
      const button = actions.querySelector<HTMLButtonElement>("button")!;
      expect(body.contains(actions)).toBe(false);
      expect(notice.getAttribute("role")).toBe(kind === "error" ? "alert" : "status");
      expect(button.disabled).toBe(kind === "success");
      const bounds = actions.getBoundingClientRect();
      expect(bounds.top).toBeGreaterThanOrEqual(panel.getBoundingClientRect().top - 1);
      expect(bounds.bottom).toBeLessThanOrEqual(dialog.getBoundingClientRect().bottom + 1);
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
      // Long feedback scrolls with the page body; the header action never leaves the view.
      expect(body.contains(notice)).toBe(true);
      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
      notice.focus();
      await userEvent.keyboard("{End}");
      body.scrollTop = body.scrollHeight;
      await expect.poll(() => body.scrollTop).toBeGreaterThan(0);
      expect(actions.getBoundingClientRect().top).toBeCloseTo(bounds.top, 2);
      expect(button.getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom);
    },
  );
  it.each([320, 1440])(
    "keeps installed-skill requirement actions on their rows and the switch in the header at %ipx",
    async (width) => {
      const { page } = await import("vitest/browser");
      await page.viewport(width, 844);
      createContainer();
      showInstalled(
        {
          description: "Read the workspace guide and preserve current permissions. ".repeat(200),
          missing: { bins: [], anyBins: ["guide-cli"], env: [], config: [], os: [] },
          install: [
            {
              id: "guide-cli",
              kind: "node",
              bins: ["guide-cli"],
              label: "Install the missing workspace guide command-line dependency",
            },
          ],
        },
        { "repo-skill": { kind: "error", message: "A previous install needs attention." } },
      );
      const { dialog } = await settledDialog();
      const panel = query(".skill-reader-dialog");
      const body = query(".skill-reader-dialog__body", panel);
      const header = query(".skill-page__header", panel);
      expect(panel.querySelector("openclaw-modal-actions")).toBeNull();
      expect(body.querySelector("input[type=password]")).not.toBeNull();
      expect(body.querySelector("[role=alert]")?.textContent).toContain("needs attention");
      expect(body.textContent).toContain("/tmp/skill");
      const install = query(".skill-requirement__control > .btn", body) as HTMLButtonElement;
      expect(install.textContent).toContain("workspace guide");
      const save = query(".skill-requirement__key .btn", body) as HTMLButtonElement;
      for (const button of [install, save]) {
        expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
        expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(
          body.getBoundingClientRect().right + 1,
        );
      }
      expect(header.querySelector('input[role="switch"]')).not.toBeNull();
      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
      expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth);
      const headerTop = header.getBoundingClientRect().top;
      expect(header.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        dialog.getBoundingClientRect().bottom,
      );
      body.scrollTop = body.scrollHeight;
      expect(body.scrollTop).toBeGreaterThan(0);
      expect(header.getBoundingClientRect().top).toBeCloseTo(headerTop, 2);
    },
  );
});
