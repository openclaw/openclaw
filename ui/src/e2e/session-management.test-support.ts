import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
  startControlUiE2eServer,
  waitForConfirmModal,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export { controlUiSessionPath, controlUiSessionUrl, installMockGateway, waitForConfirmModal };

export const collapsedSessionSectionsStorageKey = "openclaw:sidebar:sessions:collapsed-sections";
export const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

export function createSessionManagementE2eSuite(source = false) {
  return createControlUiE2eSuite({
    name: "Control UI session management mocked Gateway E2E",
    ...(source ? { startServer: () => startControlUiE2eServer(undefined, { source: true }) } : {}),
    unavailableMessage: (executablePath) =>
      `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
  });
}

/** Drawer visibility precedes the transform settling, which affects measured target bounds. */
export async function waitForMobileSidebarDrawerOpen(page: Page): Promise<void> {
  const drawer = page.locator(".shell--mobile-nav.shell--nav-drawer-open > .shell-nav");
  await drawer.waitFor({ state: "visible" });
  await drawer.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
}

/** Foreground chat startup admits the canonical roster after document load. */
export async function waitForSessionRosterHydration(page: Page): Promise<void> {
  await evaluateControlUiContext(page, async ({ sessions }) => {
    const ready = () =>
      sessions.canonicalListRevision > 0 &&
      sessions.presentation.result !== null &&
      !sessions.presentation.resultCached;
    if (ready()) {
      return;
    }
    await new Promise<void>((resolve) => {
      const unsubscribe = sessions.subscribe(() => {
        if (ready()) {
          unsubscribe();
          resolve();
        }
      });
      if (ready()) {
        unsubscribe();
        resolve();
      }
    });
  });
}

export function sessionsListResponse(
  sessions: unknown[],
  options: {
    hasMore?: boolean;
    nextOffset?: number | null;
    offset?: number;
    totalCount?: number;
  } = {},
) {
  return {
    count: sessions.length,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    hasMore: options.hasMore ?? false,
    limitApplied: 50,
    nextOffset: options.nextOffset ?? null,
    offset: options.offset ?? 0,
    path: "",
    sessions,
    totalCount: options.totalCount ?? sessions.length,
    ts: Date.now(),
  };
}

export const requireRecord = createRequireRecord("record", "expected-object-value");

export async function waitForPatch(
  gateway: MockGatewayControls,
  predicate: (params: Record<string, unknown>) => boolean,
): Promise<MockGatewayRequest> {
  const deadline = Date.now() + 10_000;
  let requests: MockGatewayRequest[] = [];
  while (Date.now() < deadline) {
    requests = await gateway.getRequests("sessions.patch");
    const match = requests.find((request) => predicate(requireRecord(request.params)));
    if (match) {
      return match;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`No matching sessions.patch request found: ${JSON.stringify(requests)}`);
}

/** Playwright reacquires replaced controls before dispatching the single click. */
export async function activateSelfRemovingControl(control: Locator): Promise<void> {
  await control.click();
}

export function trimmedTextContents(locator: Locator): Promise<string[]> {
  return locator.evaluateAll((elements) =>
    elements.map((element) => element.textContent?.trim() ?? ""),
  );
}

export function actionOpacity(button: Locator): Promise<string> {
  return button.evaluate((element) => globalThis.getComputedStyle(element).opacity);
}

export function actionPointerEvents(button: Locator): Promise<string> {
  return button.evaluate((element) => globalThis.getComputedStyle(element).pointerEvents);
}

/** The owned native menu renders each submenu beside its trigger. */
export function sessionMenuSubmenu(trigger: Locator): Locator {
  return trigger.locator("..").locator(':scope > [role="menu"]');
}

export function sessionMenuLabels(panel: Locator): Promise<string[]> {
  return panel.evaluate((element) =>
    [...element.querySelectorAll('[role^="menuitem"]')]
      .filter((item) => item.closest('[role="menu"]') === element)
      .map((item) => item.getAttribute("aria-label") ?? ""),
  );
}

/** Moves to an owned menu row through its roving-focus keyboard path. */
export async function focusSessionMenuItem(page: Page, name: string): Promise<Locator> {
  const parent = page.getByRole("menuitem", { name, exact: true });
  const index = await parent.evaluate((element) => {
    const panel = element.closest('[role="menu"]');
    return [...(panel?.querySelectorAll('[role^="menuitem"]') ?? [])]
      .filter(
        (item) =>
          item.closest('[role="menu"]') === panel &&
          !item.matches(":disabled") &&
          item.getAttribute("aria-disabled") !== "true",
      )
      .indexOf(element);
  });
  expect(index).toBeGreaterThanOrEqual(0);
  await parent.focus();
  await expect
    .poll(() =>
      parent.evaluate((element) => {
        const active = document.activeElement;
        return Boolean(
          active?.matches('[role^="menuitem"]') &&
          active.closest('[role="menu"]') === element.closest('[role="menu"]'),
        );
      }),
    )
    .toBe(true);
  await page.keyboard.press("Home");
  for (let step = 0; step < index; step += 1) {
    await page.keyboard.press("ArrowDown");
  }
  await expect
    .poll(() => parent.evaluate((element) => element === document.activeElement))
    .toBe(true);
  return parent;
}

/** Opens a native submenu through its roving-focus keyboard path. */
export async function openSessionMenuSubmenu(page: Page, name: string): Promise<void> {
  const parent = await focusSessionMenuItem(page, name);
  await expect.poll(() => parent.getAttribute("aria-haspopup")).toBe("menu");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => parent.getAttribute("aria-expanded")).toBe("true");
  await sessionMenuSubmenu(parent).waitFor({ state: "visible" });
}

/** Fills the owned input dialog and submits it the way Enter does. */
export async function submitInputDialog(page: Page, value: string): Promise<void> {
  const field = page.locator("openclaw-modal-dialog input");
  await field.waitFor({ state: "visible" });
  await field.fill(value);
  await field.press("Enter");
  await field.waitFor({ state: "detached" });
}

export async function captureUiProof(
  owner: { readonly artifactDir: string },
  page: Page,
  fileName: string,
  surface: Locator = page.locator(".shell"),
  content: readonly Locator[] = [surface],
) {
  if (!captureUiProofEnabled) {
    return;
  }
  if (page.video()) {
    await writeFile(
      path.join(owner.artifactDir, fileName),
      await takeControlUiViewportScreenshot(page, surface, content),
    );
    return;
  }
  // Nonrecording proof keeps its existing full-document framing.
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(owner.artifactDir, fileName),
  });
}
