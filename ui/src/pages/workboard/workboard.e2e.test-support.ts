import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardEvent,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import { WORKBOARD_STATUSES } from "@openclaw/workboard-contract";
import type { Browser, Locator, Page } from "playwright";
import { expect } from "vitest";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  takeControlUiElementScreenshot,
  takeControlUiScreenshotFrame,
  takeControlUiViewportScreenshot,
  waitForControlUiProofSurface,
} from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";

const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

export const button = (scope: Page | Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });
export const dialog = (page: Page, name: string) => page.getByRole("dialog", { name, exact: true });
export const expectVisible = (locator: Locator) =>
  expect.poll(() => locator.isVisible()).toBe(true);
export const expectCount = (locator: Locator, count: number) =>
  expect.poll(() => locator.count()).toBe(count);
const requireRecord = createRequireRecord("record", "expected-object-value");
export const requestParams = (request: MockGatewayRequest) => requireRecord(request.params);

export function cardsListResponse(
  cards: WorkboardCard[],
  boards = [makeBoard("default", { total: cards.length, active: cards.length })],
  statuses: readonly WorkboardStatus[] = WORKBOARD_STATUSES,
) {
  return { boards, cards, statuses };
}

export function sessionsListResponse(
  sessions: GatewaySessionRow[],
  ts = Date.parse("2026-06-01T18:00:00.000Z"),
) {
  return {
    count: sessions.length,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions,
    ts,
  };
}

export function installWorkboard(
  page: Page,
  cards: WorkboardCard[] = [],
  extra: Parameters<typeof installMockGateway>[1] = {},
) {
  return installMockGateway(page, {
    ...workboardUi,
    ...extra,
    methodResponses: {
      "config.get": configSnapshot("workboard-e2e-config", true, 2),
      "sessions.list": sessionsListResponse([]),
      "workboard.cards.list": cardsListResponse(cards),
      ...extra.methodResponses,
    },
  });
}

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
  options: { parent?: string; captureMode?: "chromium" | "webkit" | "element" } = {},
) {
  const directory = captureEnabled ? createControlUiE2eArtifactDir(scope, options.parent) : "";
  const screenshots: string[] = [];
  const videos: string[] = [];
  return {
    directory,
    async open(label = scope) {
      const rawVideoDir = path.join(directory, `${label}-raw`);
      const context = await owner.browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        recordVideo: captureEnabled ? { dir: rawVideoDir, size: viewport } : undefined,
      });
      const page = await context.newPage().catch(async (error: unknown) => {
        await context.close().catch(() => {});
        throw error;
      });
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      const video = page.video();
      return {
        page,
        async close(this: void) {
          await context.close();
          if (video) {
            const videoPath = path.join(directory, `${label}.webm`);
            await video.saveAs(videoPath);
            videos.push(videoPath);
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
        screenshots.push(filename);
      }
    },
    async writeManifest() {
      if (captureEnabled) {
        await writeFile(
          path.join(directory, "manifest.json"),
          `${JSON.stringify({ directory, screenshots, videos }, null, 2)}\n`,
        );
      }
    },
  };
}
