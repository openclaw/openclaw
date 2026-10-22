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
import { expect, onTestFinished } from "vitest";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
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
  type MockGatewayControls,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";
import { openPicker } from "../../test-helpers/select-picker-e2e.ts";

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

function controls(
  page: Page,
  gateway: MockGatewayControls,
  proof: ReturnType<typeof createWorkboardProof>,
  baseUrl: string,
) {
  const col = (status: string) =>
    page.locator(".workboard-column--" + status.toLowerCase()).first();
  const tile = (status: string, title: string) =>
    col(status).locator(".workboard-card", { hasText: title }).first();
  const strictTile = (status: string, title: string) =>
    page
      .locator(".workboard-column", { has: page.getByRole("heading", { name: status }) })
      .locator(".workboard-card", { hasText: title });
  const draft = page.locator(".workboard-draft");
  const details = page.locator(".workboard-detail");
  const b = (name: string, scope: Page | Locator = page) => button(scope, name);
  return {
    page,
    gateway,
    col,
    tile,
    strictTile,
    draft,
    details,
    b,
    snap: (name: string, surface?: Locator, content?: readonly Locator[]) =>
      proof.capture(page, name, surface, content),
    count: async (method: string) => (await gateway.getRequests(method)).length,
    setCards: (cards: WorkboardCard[]) =>
      gateway.setMethodResponse("workboard.cards.list", cardsListResponse(cards)),
    emit: (revision: number) =>
      gateway.emitGatewayEvent("plugin.workboard.changed", { epoch: "workboard-e2e", revision }),
    defer: (action: string) => gateway.deferNext("workboard.cards." + action),
    resolve: (action: string, nextCard: WorkboardCard) =>
      gateway.resolveDeferred("workboard.cards." + action, { card: nextCard }),
    async goto(route: string) {
      expect((await page.goto(baseUrl + route))?.status()).toBe(200);
    },
    async fields(fields: Record<string, string>) {
      for (const [label, text] of Object.entries(fields)) {
        await draft.getByLabel(label).fill(text);
      }
    },
    async action(target: Locator, name: string) {
      await target.hover();
      await target.locator(".workboard-card__menu-trigger").click();
      await b(name, target).click();
    },
  };
}
export function createWorkboardCase(suite: ReturnType<typeof createControlUiE2eSuite>) {
  return async function withBoard(
    name: string,
    cards: WorkboardCard[],
    options: {
      path?: string;
      size?: { width: number; height: number };
      clock?: boolean;
      gateway?: Parameters<typeof installWorkboard>[2];
      responses?: NonNullable<Parameters<typeof installWorkboard>[2]>["methodResponses"];
    } = {},
  ) {
    const proof = createWorkboardProof(suite, name, options.size ?? { width: 2400, height: 1000 });
    const { page, close } = await proof.open();
    onTestFinished(async () => {
      await close();
      await proof.writeManifest();
    });
    if (options.clock) {
      await page.clock.install();
    }
    const gateway = await installWorkboard(page, cards, {
      ...options.gateway,
      methodResponses: options.responses,
    });
    const ui = controls(page, gateway, proof, suite.server.baseUrl);
    await ui.goto(options.path ?? "workboard");
    return ui;
  };
}
export async function filters(page: Page, open: boolean) {
  const panel = page.locator(".workboard-filter-popover__panel");
  if ((await panel.isVisible()) !== open) {
    if (open) {
      await page.locator(".workboard-filter-trigger").click();
      await expect
        .poll(() => page.locator(".workboard-filter-trigger").getAttribute("aria-expanded"))
        .toBe("true");
    } else {
      await page
        .locator(".workboard-filter-popover")
        .evaluate((node) => (node as HTMLElement).hidePopover());
    }
  }
  if (open) {
    await panel.waitFor();
  } else {
    await expect.poll(() => panel.isHidden()).toBe(true);
  }
}
export async function boardPicker(page: Page) {
  await filters(page, true);
  const picker = page.locator("openclaw-select-picker").filter({
    has: page.getByRole("button", { name: /^Filter by board:/u }),
  });
  await openPicker(picker);
  return picker;
}
export async function stableRequests(gateway: MockGatewayControls, method: string, count: number) {
  const deadline = Date.now() + 10_000;
  let stableSince: number | null = null;
  let requests: Awaited<ReturnType<typeof gateway.getRequests>> = [];
  while (Date.now() < deadline) {
    requests = await gateway.getRequests(method);
    if (requests.length === count) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 250) {
        return requests;
      }
    } else {
      stableSince = null;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(
    "Timed out waiting for " + count + " " + method + " requests: " + JSON.stringify(requests),
  );
}
export async function html5Drag(source: Locator, target: Locator) {
  const from = await source.elementHandle(),
    to = await target.elementHandle();
  if (!from || !to) {
    throw new Error("Could not resolve Workboard drag source or target");
  }
  try {
    await from.evaluate((node, destination) => {
      const rect = destination.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
        clientX: rect.x + rect.width / 2,
        clientY: rect.top + 1,
      };
      node.dispatchEvent(new DragEvent("dragstart", init));
      destination.dispatchEvent(new DragEvent("dragover", init));
      destination.dispatchEvent(new DragEvent("drop", init));
      node.dispatchEvent(new DragEvent("dragend", init));
    }, to);
  } finally {
    await from.dispose();
    await to.dispose();
  }
}
