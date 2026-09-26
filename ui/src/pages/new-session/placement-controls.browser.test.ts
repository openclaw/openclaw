import { html, nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { PlaceBrowserState } from "./place-browser-state.ts";
import { renderProjectChip, resolveProjectChip } from "./project-chip.ts";
import { renderPickerTemplate } from "./where-chip.test-support.ts";
import baseStyles from "../../styles/base.css?inline";
import componentStyles from "../../styles/components.css?inline";
import placementStyles from "../../styles/new-session.css?inline";

let controls: HTMLDivElement;
let styles: HTMLStyleElement;
beforeEach(() => {
  styles = document.createElement("style");
  styles.textContent = baseStyles + componentStyles + placementStyles;
  document.head.append(styles);
  controls = document.createElement("div");
  controls.className = "new-session-page__triggers";
  document.body.append(controls);
});
afterEach(() => {
  render(nothing, controls);
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
  "caps and fades phone placement text at $width px ($direction, short=$shortLabels)",
  async ({ width, shortLabels, direction }) => {
    await page.viewport(width, 900);
    controls.dir = direction;
    const profileId = shortLabels ? "prod" : "production-europe-development";
    const workspaceLabel = shortLabels ? "app" : "customer-analytics-dashboard";
    const workspace = `/workspace/${workspaceLabel}`;
    const where = renderPickerTemplate(
      true,
      undefined,
      {
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
      },
      { popoverOpen: false },
    );
    const onApplyFolder = vi.fn();
    const project = renderProjectChip({
      state: resolveProjectChip({
        folder: workspace,
        workspace,
        projectId: "",
        selectedRemoteProject: null,
        projects: [],
        recents: [],
        projectQuery: "",
      }),
      browseAvailable: true,
      isAdmin: true,
      canWrite: true,
      folder: workspace,
      workspace,
      projects: [],
      projectQuery: "",
      projectSearchAvailable: false,
      projectAddAvailable: false,
      remoteProjects: [],
      selectedRemoteProject: null,
      projectSearchCredentialMissing: false,
      projectSearchLoading: false,
      projectSearchError: null,
      projectId: "",
      gatewayLabel: "Gateway",
      submitting: false,
      pendingPlacement: false,
      popoverOpen: false,
      popoverHiding: false,
      browserOpen: false,
      browser: new PlaceBrowserState(vi.fn(), vi.fn()),
      registerProjectPath: null,
      registeringProject: false,
      onGuardTransition: vi.fn(),
      onPopoverShow: vi.fn(),
      onPopoverHide: vi.fn(),
      onPopoverAfterHide: vi.fn(),
      onSelectProject: vi.fn(),
      onProjectQueryInput: vi.fn(),
      onSelectRemoteProject: vi.fn(),
      onApplyFolder,
      onBrowse: vi.fn(),
      onBrowserBack: vi.fn(),
      onRegisterProject: vi.fn(),
      onClose: vi.fn(),
    });
    render(html`${where}${project}`, controls);
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const environment = controls.querySelector<HTMLButtonElement>("#new-session-where-trigger")!;
    const workspaceTrigger = controls.querySelector<HTMLButtonElement>(
      "#new-session-project-trigger",
    )!;
    const envBox = environment.getBoundingClientRect();
    const workspaceBox = workspaceTrigger.getBoundingClientRect();
    if (width <= 560) {
      expect(workspaceBox.top).toBeGreaterThanOrEqual(envBox.bottom);
      expect(direction === "rtl" ? workspaceBox.right : workspaceBox.left).toBeCloseTo(
        direction === "rtl" ? envBox.right : envBox.left,
        0,
      );
      const environmentIcon = environment
        .querySelector<HTMLElement>(".new-session-page__target-icon")!
        .getBoundingClientRect();
      const workspaceIcon = workspaceTrigger
        .querySelector<HTMLElement>(".new-session-page__target-icon")!
        .getBoundingClientRect();
      expect(environmentIcon.width).toBeCloseTo(workspaceIcon.width, 1);
      expect(environmentIcon.left + environmentIcon.width / 2).toBeCloseTo(
        workspaceIcon.left + workspaceIcon.width / 2,
        1,
      );
      const label = environment.querySelector<HTMLElement>(".new-session-page__trigger-label")!;
      const summary = environment.querySelector<HTMLElement>(".new-session-page__trigger-summary")!;
      expect(summary.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        label.getBoundingClientRect().bottom,
      );
      expect(summary.textContent).toBe("Windows (WSL2) · Large");
    } else {
      const environmentRow = environment
        .closest(".new-session-page__select")!
        .getBoundingClientRect();
      const workspaceRow = workspaceTrigger
        .closest(".new-session-page__select")!
        .getBoundingClientRect();
      expect(workspaceRow.top + workspaceRow.height / 2).toBeCloseTo(
        environmentRow.top + environmentRow.height / 2,
        0,
      );
      expect(workspaceBox.left).toBeGreaterThanOrEqual(envBox.right);
    }
    for (const trigger of [environment, workspaceTrigger]) {
      const box = trigger.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(width <= 560 ? 44 : 26);
      const chevron = trigger.querySelector<HTMLElement>(
        width <= 560
          ? ".new-session-page__trigger-chevron--mobile"
          : ".new-session-page__trigger-chevron--desktop",
      )!;
      const labelBoxes = Array.from(
        trigger.querySelectorAll<HTMLElement>(
          ".new-session-page__trigger-label, .new-session-page__trigger-summary",
        ),
        (label) => label.getBoundingClientRect(),
      );
      const labelGap =
        direction === "rtl"
          ? Math.min(...labelBoxes.map((labelBox) => labelBox.left)) -
            chevron.getBoundingClientRect().right
          : chevron.getBoundingClientRect().left -
            Math.max(...labelBoxes.map((labelBox) => labelBox.right));
      expect(labelGap).toBeGreaterThanOrEqual(width <= 560 ? 4 : 8);
      if (width <= 560) {
        expect(labelGap).toBeLessThanOrEqual(4.5);
        const availableWidth = trigger.closest<HTMLElement>(
          ".new-session-page__select",
        )!.clientWidth;
        expect(box.width).toBeLessThanOrEqual(availableWidth * 0.9 + 1);
        const overflows = Array.from(
          trigger.querySelectorAll<HTMLElement>(
            ".new-session-page__trigger-label, .new-session-page__trigger-summary",
          ),
        ).some((label) => label.scrollWidth > label.clientWidth + 1);
        if (overflows) {
          expect(box.width).toBeCloseTo(availableWidth * 0.9, 0);
        } else {
          const textBoxes = Array.from(
            trigger.querySelectorAll<HTMLElement>(
              ".new-session-page__trigger-label, .new-session-page__trigger-summary",
            ),
            (label) => {
              const range = document.createRange();
              range.selectNodeContents(label);
              return range.getBoundingClientRect();
            },
          );
          const visibleGap =
            direction === "rtl"
              ? Math.min(...textBoxes.map((textBox) => textBox.left)) -
                chevron.getBoundingClientRect().right
              : chevron.getBoundingClientRect().left -
                Math.max(...textBoxes.map((textBox) => textBox.right));
          // The fade padding and chevron margin form one spacing budget.
          expect(visibleGap).toBeGreaterThanOrEqual(4);
          expect(visibleGap).toBeLessThanOrEqual(12.5);
        }
      }
      for (const label of trigger.querySelectorAll<HTMLElement>(
        ".new-session-page__trigger-label, .new-session-page__trigger-summary",
      )) {
        const style = getComputedStyle(label);
        expect(style.whiteSpace).toBe("nowrap");
        expect(label.scrollHeight).toBeLessThanOrEqual(label.clientHeight + 1);
        if (width <= 560) {
          expect(style.textOverflow).toBe("clip");
          expect(style.maskImage).toContain(direction === "rtl" ? "to left" : "to right");
          if (shortLabels) {
            const textRange = document.createRange();
            textRange.selectNodeContents(label);
            expect(textRange.getBoundingClientRect().right).toBeLessThanOrEqual(
              label.getBoundingClientRect().right - Number.parseFloat(style.paddingInlineEnd) + 1,
            );
          }
        } else {
          expect(style.maskImage).toBe("none");
          expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
        }
      }
    }
    expect(controls.scrollWidth).toBeLessThanOrEqual(controls.clientWidth);
    await expect
      .element(
        page.getByRole("button", {
          name: `Where: ${profileId}, Windows (WSL2) · Large`,
          exact: true,
        }),
      )
      .toHaveAccessibleDescription("Cloud worker provider: AWS");
    // Exercise the real workspace popover after reflow, not a static label facsimile.
    await page.getByRole("button", { name: `What: ${workspaceLabel}`, exact: true }).click();
    await page.getByRole("button", { name: workspaceLabel, exact: true }).click();
    expect(onApplyFolder).toHaveBeenCalledExactlyOnceWith(workspace);
  },
);
