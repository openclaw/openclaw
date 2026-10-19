import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardEvent,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { expect } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  takeControlUiScreenshotFrame,
  takeControlUiViewportScreenshot,
  waitForControlUiProofSurface,
} from "../../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiE2eWaitTimeoutMs } from "../../test-helpers/control-ui-e2e.ts";

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

export const focused = (locator: Locator) =>
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
  owner: { readonly browser: Browser },
  scope: string,
  viewport = { width: 2400, height: 1000 },
  options: { parent?: string; captureMode?: "chromium" | "webkit" } = {},
) {
  const directory = captureEnabled ? createControlUiE2eArtifactDir(scope, options.parent) : "";
  const artifacts: { directory: string; screenshots: string[]; videos: string[] } = {
    directory,
    screenshots: [],
    videos: [],
  };
  return {
    directory,
    async open(label = scope) {
      const rawVideoDir = path.join(directory, `${label}-raw`);
      if (captureEnabled) {
        await mkdir(rawVideoDir, { recursive: true });
      }
      let context: BrowserContext | undefined;
      let page: Page | undefined;
      try {
        context = await owner.browser.newContext({
          locale: "en-US",
          serviceWorkers: "block",
          viewport,
          recordVideo: captureEnabled ? { dir: rawVideoDir, size: viewport } : undefined,
        });
        page = await context.newPage();
        page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      } catch (error) {
        await page?.close().catch(() => {});
        await context?.close().catch(() => {});
        throw error;
      }
      const openedContext = context;
      const video = page.video();
      return {
        page,
        async close(this: void) {
          await openedContext.close();
          if (video) {
            const videoPath = path.join(directory, `${label}.webm`);
            await copyFile(await video.path(), videoPath);
            artifacts.videos.push(videoPath);
            // Keep raw evidence if closing or copying the recording fails.
            await rm(rawVideoDir, { force: true, recursive: true });
          }
        },
      };
    },
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
          const png =
            options.captureMode === "chromium"
              ? (
                  await takeControlUiScreenshotFrame(page, surface, content, {
                    animations: "disabled",
                  })
                ).png
              : await takeControlUiViewportScreenshot(page, surface, content);
          await writeFile(filename, png);
        }
        artifacts.screenshots.push(filename);
      }
    },
    async writeManifest() {
      if (captureEnabled) {
        await writeFile(
          path.join(directory, "manifest.json"),
          `${JSON.stringify(artifacts, null, 2)}\n`,
          "utf-8",
        );
      }
    },
  };
}
