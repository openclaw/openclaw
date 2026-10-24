import { availableParallelism } from "node:os";
import type { Locator, Page } from "playwright";
import type { MockGatewayWindow } from "./control-ui-e2e-contract.ts";

const loadedWaitTimeoutMs = 30_000;

// Loaded CI, small hosts, and cold source servers need the larger render budget.
export let controlUiE2eWaitTimeoutMs =
  process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" || availableParallelism() <= 4
    ? loadedWaitTimeoutMs
    : 10_000;

export function extendControlUiE2eWaitTimeoutForSourceServer(): void {
  controlUiE2eWaitTimeoutMs = loadedWaitTimeoutMs;
}

/** Selected descriptors and cached rows can render before the authoritative roster. */
export async function waitForControlUiInitialRoster(page: Page): Promise<void> {
  try {
    await page
      .waitForFunction(
        () => {
          // A commit-only navigation can finish before HTML reaches the static app tag.
          if (document.readyState === "loading") {
            return false;
          }
          if (!document.querySelector("openclaw-app")) {
            return true;
          }
          const readiness = window.openclawControlUi?.snapshot();
          // Offline mocks cannot handshake; the app still owns boot completion.
          const offline =
            (window as MockGatewayWindow).openclawControlUiE2eGateway?.online === false;
          return readiness?.ready || (offline && readiness?.booted === true);
        },
        undefined,
        { timeout: controlUiE2eWaitTimeoutMs },
      )
      .then((ready) => ready.dispose());
  } catch (cause) {
    throw new Error(
      "Control UI initial roster did not finish loading and rendering. For intentional pre-roster scenarios, set awaitInitialRoster: false in installMockGateway.",
      { cause },
    );
  }
}

export function installControlUiRosterNavigationWait(page: Page): void {
  // Preserve navigation's Response while waiting beyond the selected descriptor.
  const goto = page.goto.bind(page);
  const reload = page.reload.bind(page);
  const afterRoster = async (navigation: ReturnType<Page["goto"]>) => {
    const response = await navigation;
    await waitForControlUiInitialRoster(page);
    return response;
  };
  page.goto = async (...args) => afterRoster(goto(...args));
  page.reload = async (...args) => afterRoster(reload(...args));
}

/** A sent connect request is not the delivered Gateway handshake. */
export async function waitForControlUiGatewayReady(page: Page, timeout?: number): Promise<void> {
  await page.waitForFunction(
    () => window.openclawControlUi?.snapshot().gatewayPhase === "connected",
    undefined,
    { timeout },
  );
}

/** Wait for both the Gateway lifecycle and its dedicated visible reconnect status. */
export async function waitForControlUiGatewayReconnecting(page: Page): Promise<void> {
  await Promise.all([
    page.waitForFunction(
      () => window.openclawControlUi?.snapshot().gatewayPhase === "reconnecting",
      undefined,
      { timeout: controlUiE2eWaitTimeoutMs },
    ),
    page
      .getByRole("button", { name: /Reconnecting…/ })
      .or(page.locator(".gateway-status__label:visible", { hasText: "Reconnecting…" }))
      .first()
      .waitFor({ state: "visible", timeout: controlUiE2eWaitTimeoutMs }),
  ]);
}

/** Wait until the shell can accept the shortcut that activates the lazy terminal. */
export async function waitForControlUiTerminalReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => window.openclawControlUi?.snapshot().terminalActivationReady === true,
  );
}

/** In-app confirms must reach full opacity before accepting clicks. */
export async function waitForConfirmModal(
  page: Page,
  // Callers with other open dialogs identify their intended modal before waiting for readiness.
  modal: Locator = page.locator("openclaw-modal-dialog").last(),
): Promise<Locator> {
  const dialog = modal.locator("dialog[open]");
  await dialog.waitFor({ state: "visible", timeout: controlUiE2eWaitTimeoutMs });
  const element = await dialog.elementHandle();
  try {
    await page
      .waitForFunction(
        (target) => target !== null && getComputedStyle(target).opacity === "1",
        element,
        { timeout: controlUiE2eWaitTimeoutMs },
      )
      .then((settled) => settled.dispose());
  } finally {
    await element?.dispose();
  }
  return modal;
}
