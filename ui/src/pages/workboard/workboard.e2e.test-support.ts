import { writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardEvent,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  takeControlUiElementScreenshot,
  takeControlUiScreenshotFrame,
  takeControlUiViewportScreenshot,
  waitForControlUiProofSurface,
} from "../../test-helpers/control-ui-e2e-screenshot.ts";

const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

export const button = (scope: Page | Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });

export function configSnapshot(hash: string, enabled = true, indent?: number) {
  const config = { plugins: { entries: { workboard: { enabled } } } };
  return {
    config,
    hash,
    path: "/tmp/openclaw-e2e/openclaw.json",
    raw: JSON.stringify(config, null, indent),
    resolved: config,
    sourceConfig: config,
  };
}

const focused = (locator: Locator) =>
  locator.evaluate((element) => element === document.activeElement);
export async function expectFocus(locator: Locator, within = false) {
  await expect
    .poll(() =>
      within ? locator.evaluate((element) => element.matches(":focus-within")) : focused(locator),
    )
    .toBe(true);
}

export function moved(
  id: string,
  at: number,
  fromStatus: WorkboardStatus,
  toStatus: WorkboardStatus,
): WorkboardEvent {
  return { id, kind: "moved", at, fromStatus, toStatus };
}

export function makeCard(
  overrides: Partial<WorkboardCard> & Pick<WorkboardCard, "id" | "title">,
  time = 1,
): WorkboardCard {
  return {
    status: "todo",
    priority: "normal",
    labels: [],
    position: 1000,
    createdAt: time,
    updatedAt: time,
    ...overrides,
  };
}

export function makeBoard(
  id: string,
  overrides: Partial<WorkboardBoardSummary> = {},
): WorkboardBoardSummary {
  return { id, total: 0, active: 0, archived: 0, byStatus: {}, ...overrides };
}

export function createWorkboardProof(
  scope: string,
  options: { parent?: string; captureMode?: "chromium" | "webkit" | "element" } = {},
) {
  const directory = captureEnabled ? createControlUiE2eArtifactDir(scope, options.parent) : "";
  return {
    directory,
    async capture(
      page: Page,
      name: string,
      surface = page.locator(".shell"),
      content: readonly Locator[] = [page.locator(".workboard-page-title")],
    ) {
      if (captureEnabled) {
        const filename = path.join(directory, `${name}.png`);
        if (options.captureMode === "webkit") {
          // The frame encoder requires CDP; WebKit shares only semantic readiness.
          await waitForControlUiProofSurface(surface, content);
          await page.screenshot({ path: filename, animations: "disabled" });
        } else {
          const capture =
            options.captureMode === "element"
              ? takeControlUiElementScreenshot
              : takeControlUiViewportScreenshot;
          const png =
            options.captureMode === "chromium"
              ? (
                  await takeControlUiScreenshotFrame(page, surface, content, {
                    animations: "disabled",
                  })
                ).png
              : await capture(page, surface, content);
          await writeFile(filename, png);
        }
      }
    },
  };
}
