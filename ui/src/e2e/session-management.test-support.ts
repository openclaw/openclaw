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
  await drawer.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
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
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
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
export const activateSelfRemovingControl = (control: Locator): Promise<void> => control.click();

export const trimmedTextContents = (locator: Locator): Promise<string[]> =>
  locator.evaluateAll((elements) => elements.map((element) => element.textContent?.trim() ?? ""));

export const actionOpacity = (button: Locator): Promise<string> =>
  button.evaluate((element) => globalThis.getComputedStyle(element).opacity);

export const actionPointerEvents = (button: Locator): Promise<string> =>
  button.evaluate((element) => globalThis.getComputedStyle(element).pointerEvents);

/** The owned native menu renders each submenu beside its trigger. */
export const sessionMenuSubmenu = (trigger: Locator): Locator =>
  trigger.locator("..").locator(':scope > [role="menu"]');

export const sessionMenuLabels = (panel: Locator): Promise<string[]> =>
  panel.evaluate((element) =>
    [...element.querySelectorAll('[role^="menuitem"]')]
      .filter((item) => item.closest('[role="menu"]') === element)
      .map((item) => item.getAttribute("aria-label") ?? ""),
  );

/** Moves to an owned menu row through its roving-focus keyboard path. */
export async function focusSessionMenuItem(page: Page, name: string): Promise<Locator> {
  const parent = page.getByRole("menuitem", { name, exact: true });
  const index = await parent.evaluate((element) => {
    const panel = element.closest('[role="menu"]');
    const selector = '[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])';
    return [...(panel?.querySelectorAll(selector) ?? [])]
      .filter((item) => item.closest('[role="menu"]') === panel)
      .indexOf(element);
  });
  expect(index).toBeGreaterThanOrEqual(0);
  await parent.focus();
  await expect
    .poll(() =>
      parent.evaluate((element) => ({
        menuItem: document.activeElement?.matches('[role^="menuitem"]'),
        sameMenu:
          document.activeElement?.closest('[role="menu"]') === element.closest('[role="menu"]'),
      })),
    )
    .toEqual({ menuItem: true, sameMenu: true });
  await page.keyboard.press("Home");
  for (let step = 0; step < index; step += 1) {
    await page.keyboard.press("ArrowDown");
  }
  await expect
    .poll(() => parent.evaluate((element) => element === document.activeElement))
    .toBe(true);
  return parent;
}

export async function openSessionMenuSubmenu(page: Page, name: string): Promise<void> {
  const parent = await focusSessionMenuItem(page, name);
  await expect.poll(() => parent.getAttribute("aria-haspopup")).toBe("menu");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => parent.getAttribute("aria-expanded")).toBe("true");
  await sessionMenuSubmenu(parent).waitFor({ state: "visible" });
}

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
  // Nonrecording proof keeps its existing full-document framing.
  const destination = path.join(owner.artifactDir, fileName);
  await (page.video()
    ? writeFile(destination, await takeControlUiViewportScreenshot(page, surface, content))
    : page.screenshot({ animations: "disabled", fullPage: true, path: destination }));
}
