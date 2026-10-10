import type { Locator, Page } from "playwright";
import type { ControlUiReadiness } from "../app/control-ui-readiness.ts";
import type { MockGatewayWindow } from "./control-ui-e2e-contract.ts";
// Loaded CI runners regularly stall real Chromium renders past 10s; the larger
// CI budget trades failure latency, not coverage (mirrors the ui-e2e vitest
// config's expect.poll budget). Local runs keep the snappy 10s deadline.
export const controlUiE2eWaitTimeoutMs =
  process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 30_000 : 10_000;

/** Selected descriptors and cached rows can render before the authoritative roster. */
export async function waitForControlUiInitialRoster(page: Page): Promise<void> {
  try {
    const ready = await page.waitForFunction(
      () => {
        // A commit-only navigation can finish before HTML reaches the static app tag.
        if (document.readyState === "loading") {
          return false;
        }
        if (!document.querySelector("openclaw-app")) {
          return true;
        }
        const readiness: ReturnType<ControlUiReadiness["hook"]["snapshot"]> | undefined =
          window.openclawControlUi?.snapshot();
        // A deliberately offline mock cannot finish its first handshake. The app
        // still owns boot completion; only this transport exception is test-owned.
        const offline = (window as MockGatewayWindow).openclawControlUiE2eGateway?.online === false;
        return readiness?.ready || (offline && readiness?.booted === true);
      },
      undefined,
      { timeout: controlUiE2eWaitTimeoutMs },
    );
    await ready.dispose();
  } catch (cause) {
    throw new Error(
      "Control UI initial roster did not finish loading and rendering. For intentional pre-roster scenarios, set awaitInitialRoster: false in installMockGateway.",
      { cause },
    );
  }
}

/** A sent connect request is not the delivered Gateway handshake. */
export async function waitForControlUiGatewayReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    return window.openclawControlUi?.snapshot().gatewayPhase === "connected";
  });
}

/** Wait for both the Gateway lifecycle and its dedicated visible reconnect status. */
export async function waitForControlUiGatewayReconnecting(page: Page): Promise<void> {
  await Promise.all([
    page.waitForFunction(
      () => {
        return window.openclawControlUi?.snapshot().gatewayPhase === "reconnecting";
      },
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

/**
 * Wait for the settled in-app confirmation modal. Control UI routes destructive
 * confirms through `showConfirmDialog`, so no native browser dialog ever fires;
 * waiting for full opacity keeps the click from landing mid-animation.
 */
export async function waitForConfirmModal(page: Page): Promise<Locator> {
  const modal = page.locator("openclaw-modal-dialog").last();
  // Playwright's semantic DOM locator pierces any remaining component shadows.
  const dialog = modal.locator("dialog[open]");
  await dialog.waitFor({ state: "visible", timeout: controlUiE2eWaitTimeoutMs });
  const element = await dialog.elementHandle();
  try {
    const settled = await page.waitForFunction(
      (target) => target !== null && getComputedStyle(target).opacity === "1",
      element,
      { timeout: controlUiE2eWaitTimeoutMs },
    );
    await settled.dispose();
  } finally {
    await element?.dispose();
  }
  return modal;
}
