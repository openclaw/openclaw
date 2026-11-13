import { createComponent } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { CheckoutChip } from "./checkout-chip.tsx";
import { resolveProjectChip } from "./project-chip.ts";
import { ProjectChip } from "./project-chip.tsx";
import { pickerParams } from "./where-chip.test-support.ts";
import { WhereChip } from "./where-chip.tsx";
import baseStyles from "../../styles/base.css?inline";
import composerStyles from "../../styles/chat/composer-surface.css?inline";
import componentStyles from "../../styles/components.css?inline";
import placementStyles from "../../styles/new-session.css?inline";

let fixture: HTMLDivElement;
let composer: HTMLDivElement;
let controls: HTMLDivElement;
let styles: HTMLStyleElement;
const button = (name: string) => page.getByRole("button", { name, exact: true });
const bounds = (element: Element) => element.getBoundingClientRect();
const query = (selector: string, root: Element = controls) =>
  root.querySelector<HTMLElement>(selector)!;
beforeEach(() => {
  styles = document.createElement("style");
  styles.textContent = baseStyles + componentStyles + composerStyles + placementStyles;
  document.head.append(styles);
  fixture = document.createElement("div");
  const subtitle = document.createElement("div");
  subtitle.className = "new-session-page__welcome-hint";
  subtitle.textContent = "New session";
  const shell = document.createElement("div");
  shell.className = "agent-chat__composer-shell new-session-page__composer";
  shell.style.marginTop = "400px";
  composer = document.createElement("div");
  composer.className = "agent-chat__input";
  fixture.append(subtitle, shell);
  controls = document.createElement("div");
  controls.className = "new-session-page__context-tray";
  const row = document.createElement("div");
  row.className = "new-session-page__triggers";
  controls.append(row);
  shell.append(composer, controls);
  document.body.append(fixture);
});
afterEach(() => {
  cleanupSolid();
  fixture.remove();
  styles.remove();
});

it.each([
  { width: 320, shortLabels: false, direction: "ltr" },
  { width: 390, shortLabels: false, direction: "ltr" },
  { width: 560, shortLabels: false, direction: "ltr" },
  { width: 1440, shortLabels: false, direction: "ltr" },
  { width: 390, shortLabels: true, direction: "ltr" },
  { width: 390, shortLabels: false, direction: "rtl" },
])(
  "keeps placement controls above the composer on phones and inline on desktop at $width px ($direction, short=$shortLabels)",
  async ({ width, shortLabels, direction }) => {
    await page.viewport(width, 900);
    controls.dir = direction;
    const profileId = shortLabels ? "prod" : "production-europe-development";
    const workspaceLabel = shortLabels ? "app" : "customer-analytics-dashboard";
    const workspace = `/workspace/${workspaceLabel}`;
    const where = pickerParams(true, undefined, {
      cloudProfileId: profileId,
      cloudProfiles: [
        {
          id: profileId,
          providerId: "crabbox",
          providerDisplayId: "aws",
          operatingSystems: [{ id: "windows", label: "Windows (WSL2)", default: true }],
          machines: [{ id: "large", label: "Large", default: true }],
        },
      ],
    });
    const { place } = where.params;
    vi.spyOn(place.browser, "popoverOpen").mockReturnValue(false);
    vi.spyOn(place, "folder", "get").mockReturnValue(workspace);
    vi.spyOn(place, "workspacePath").mockReturnValue(workspace);
    vi.spyOn(place, "browseAvailable").mockReturnValue(true);
    vi.spyOn(place, "deviceFolderAvailable", "get").mockReturnValue(false);
    const onApplyFolder = vi.spyOn(place, "applyFolder").mockImplementation(() => {});
    const project = {
      params: where.params,
      state: resolveProjectChip({
        folder: workspace,
        workspace,
        projectId: "",
        selectedRemoteProject: null,
        projects: [],
        recents: [],
        projectQuery: "",
      }),
      nativeTerminal: false,
    };
    const row = query(".new-session-page__triggers");
    mountSolid(() => createComponent(WhereChip, where), { container: row });
    const workspaceGroup = document.createElement("div");
    workspaceGroup.className = "new-session-page__workspace";
    row.append(workspaceGroup);
    mountSolid(
      () => [
        createComponent(ProjectChip, project),
        createComponent(CheckoutChip, { params: where.params, folderLabel: workspaceLabel }),
      ],
      { container: workspaceGroup },
    );
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const environment = query("#new-session-where-trigger");
    const workspaceTrigger = query("#new-session-project-trigger");
    const checkout = query("#new-session-checkout-trigger");
    const mobile = width <= 768;
    const envBox = bounds(environment);
    const workspaceBox = bounds(workspaceTrigger);
    const composerBox = bounds(composer);
    const trayBox = bounds(controls);
    expect(trayBox.left).toBe(composerBox.left);
    expect(trayBox.right).toBe(composerBox.right);
    if (mobile) {
      expect(trayBox.bottom).toBeLessThan(composerBox.top);
      expect(workspaceBox.top).toBeGreaterThan(envBox.bottom);
      expect(bounds(checkout).top).toBeGreaterThan(workspaceBox.bottom);
      for (const trigger of [workspaceTrigger, checkout]) {
        expect(bounds(trigger).left).toBe(envBox.left);
      }
    } else {
      // Flex aligns the slots; inline button baselines can differ inside them.
      const envRow = bounds(environment.closest(".new-session-page__select")!);
      const workspaceRow = bounds(workspaceTrigger.closest(".new-session-page__select")!);
      expect(workspaceRow.top + workspaceRow.height / 2).toBeCloseTo(
        envRow.top + envRow.height / 2,
        0,
      );
      if (direction === "rtl") {
        expect(workspaceBox.right).toBeLessThanOrEqual(envBox.left);
      } else {
        expect(workspaceBox.left).toBeGreaterThanOrEqual(envBox.right);
      }
      expect(trayBox.top).toBeLessThan(composerBox.bottom);
    }
    const summary = query(".new-session-page__trigger-summary", environment);
    expect(summary.textContent).toBe("Windows (WSL2) · Large");
    expect(summary.checkVisibility()).toBe(true);
    for (const trigger of [environment, workspaceTrigger, checkout]) {
      const box = bounds(trigger);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
      expect(box.height).toBe(mobile ? 36 : 26);
      if (mobile) {
        const slot = trigger.closest<HTMLElement>(".new-session-page__select")!;
        expect.soft(box.width).toBeCloseTo(slot.clientWidth, 0);
        expect(box.width).toBeGreaterThanOrEqual(44);
      }
      const labels = [
        ...trigger.querySelectorAll<HTMLElement>(
          ".new-session-page__trigger-label, .new-session-page__trigger-summary",
        ),
      ].filter((label) => label.checkVisibility());
      for (const label of labels) {
        const style = getComputedStyle(label);
        expect(style.whiteSpace).toBe("nowrap");
        expect(style.textOverflow).toBe("ellipsis");
        expect(style.maskImage).toBe("none");
        expect(label.scrollHeight).toBeLessThanOrEqual(label.clientHeight + 1);
        if ((shortLabels && trigger !== checkout) || !mobile) {
          expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
        }
      }
    }
    if (mobile) {
      expect(bounds(environment.closest(".new-session-page__select")!).width).toBe(
        row.clientWidth - 30,
      );
      expect(
        query(".new-session-page__trigger-label", workspaceTrigger).clientWidth,
      ).toBeGreaterThan(0);
    }
    expect(controls.scrollWidth).toBeLessThanOrEqual(controls.clientWidth);
    await expect
      .element(button(`Where: ${profileId}, Windows (WSL2) · Large`))
      .toHaveAccessibleDescription("Cloud provider: AWS");
    // Exercise the real workspace popover after reflow, not a static label facsimile.
    await button(`What: ${workspaceLabel}`).click();
    await expect.element(button(workspaceLabel)).toBeVisible();
    const panel = query("#new-session-project-popover");
    await expect.poll(() => panel.dataset.phase).toBe("open");
    expect(bounds(panel).left).toBe(composerBox.left);
    expect(bounds(panel).right).toBe(composerBox.right);
    if (mobile) {
      // Lazy content can resize the already-open loading surface.
      await expect.poll(() => bounds(panel).top).toBeLessThan(trayBox.top);
      expect(bounds(panel).bottom).toBe(trayBox.bottom);
      expect(bounds(panel).bottom).toBeLessThan(composerBox.top);
    } else {
      const search = page.getByRole("searchbox", { name: "Search projects or paste a Git URL" });
      await expect.element(search).toHaveFocus();
      await userEvent.tab({ shift: true });
      await userEvent.tab({ shift: true });
      await expect
        .poll(() => query("#new-session-project-popover").hasAttribute("open"))
        .toBe(false);
      await expect.element(button(`What: ${workspaceLabel}`)).toHaveFocus();
      await button(`What: ${workspaceLabel}`).click();
    }
    await button(workspaceLabel).click();
    expect(onApplyFolder).toHaveBeenCalledExactlyOnceWith(workspace);
  },
);

it("selects the second device option with two ArrowDown presses from search", async () => {
  await page.viewport(1440, 900);
  const onSelectDevice = vi.fn();
  const where = pickerParams(true, undefined, {}, { onSelectDevice });
  mountSolid(() => createComponent(WhereChip, where), {
    container: query(".new-session-page__triggers"),
  });
  const search = page.getByRole("searchbox", { name: "Search devices" });
  await search.click();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(onSelectDevice).toHaveBeenCalledExactlyOnceWith("");
});
