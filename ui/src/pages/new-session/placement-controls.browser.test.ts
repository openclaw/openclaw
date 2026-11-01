import { createComponent } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { resolveProjectChip } from "./project-chip.ts";
import { ProjectChip } from "./project-chip.tsx";
import { pickerParams } from "./where-chip.test-support.ts";
import { WhereChip } from "./where-chip.tsx";
import baseStyles from "../../styles/base.css?inline";
import componentStyles from "../../styles/components.css?inline";
import placementStyles from "../../styles/new-session.css?inline";

let controls: HTMLDivElement;
let styles: HTMLStyleElement;
const button = (name: string) => page.getByRole("button", { name, exact: true });
const bounds = (element: Element) => element.getBoundingClientRect();
const query = (selector: string, root: Element = controls) =>
  root.querySelector<HTMLElement>(selector)!;
beforeEach(() => {
  styles = document.createElement("style");
  styles.textContent = baseStyles + componentStyles + placementStyles;
  document.head.append(styles);
  controls = document.createElement("div");
  controls.className = "new-session-page__triggers";
  document.body.append(controls);
});
afterEach(() => {
  cleanupSolid();
  controls.remove();
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
  "keeps placement controls inline with truncated labels at $width px ($direction, short=$shortLabels)",
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
    mountSolid(() => [createComponent(WhereChip, where), createComponent(ProjectChip, project)], {
      container: controls,
    });
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const environment = query("#new-session-where-trigger");
    const workspaceTrigger = query("#new-session-project-trigger");
    const envBox = bounds(environment);
    const workspaceBox = bounds(workspaceTrigger);
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
    const summary = query(".new-session-page__trigger-summary", environment);
    expect(summary.textContent).toBe("Windows (WSL2) · Large");
    expect(summary.checkVisibility()).toBe(width > 560);
    for (const trigger of [environment, workspaceTrigger]) {
      const box = bounds(trigger);
      const mobile = width <= 560;
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(mobile ? 44 : 26);
      if (mobile) {
        const slot = trigger.closest<HTMLElement>(".new-session-page__select")!;
        expect(box.width).toBeCloseTo(slot.clientWidth, 0);
        expect(box.width).toBeGreaterThanOrEqual(44);
      }
      const chevron = bounds(
        query(`.new-session-page__trigger-chevron--${mobile ? "mobile" : "desktop"}`, trigger),
      );
      const labels = [
        ...trigger.querySelectorAll<HTMLElement>(
          ".new-session-page__trigger-label, .new-session-page__trigger-summary",
        ),
      ].filter((label) => label.checkVisibility());
      const boxes = labels.map(bounds);
      const gap =
        direction === "rtl"
          ? Math.min(...boxes.map((label) => label.left)) - chevron.right
          : chevron.left - Math.max(...boxes.map((label) => label.right));
      expect(gap).toBeGreaterThanOrEqual(mobile ? 3 : 8);
      for (const label of labels) {
        const style = getComputedStyle(label);
        expect(style.whiteSpace).toBe("nowrap");
        expect(style.textOverflow).toBe("ellipsis");
        expect(style.maskImage).toBe("none");
        expect(label.scrollHeight).toBeLessThanOrEqual(label.clientHeight + 1);
        if (shortLabels || width > 560) {
          expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
        }
      }
    }
    expect(controls.scrollWidth).toBeLessThanOrEqual(controls.clientWidth);
    await expect
      .element(button(`Where: ${profileId}, Windows (WSL2) · Large`))
      .toHaveAccessibleDescription("Cloud worker provider: AWS");
    // Exercise the real workspace popover after reflow, not a static label facsimile.
    await button(`What: ${workspaceLabel}`).click();
    await button(workspaceLabel).click();
    expect(onApplyFolder).toHaveBeenCalledExactlyOnceWith(workspace);
  },
);
