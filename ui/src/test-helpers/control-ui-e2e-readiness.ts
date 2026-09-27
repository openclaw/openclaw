import type { Locator, Page } from "playwright";
// Loaded CI runners regularly stall real Chromium renders past 10s; the larger
// CI budget trades failure latency, not coverage (mirrors the ui-e2e vitest
// config's expect.poll budget). Local runs keep the snappy 10s deadline.
export const controlUiE2eWaitTimeoutMs =
  process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 30_000 : 10_000;

/** A sent connect request is not the delivered Gateway handshake. */
export async function waitForControlUiGatewayReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & { runtime?: { context?: { gateway?: { snapshot?: { phase?: string } } } } })
      | null;
    return app?.runtime?.context?.gateway?.snapshot?.phase === "connected";
  });
}

/** Wait for both the Gateway lifecycle and its dedicated visible reconnect status. */
export async function waitForControlUiGatewayReconnecting(page: Page): Promise<void> {
  await Promise.all([
    page.waitForFunction(
      () => {
        const app = document.querySelector("openclaw-app") as
          | (HTMLElement & {
              runtime?: { context?: { gateway?: { snapshot?: { phase?: string } } } };
            })
          | null;
        return app?.runtime?.context?.gateway?.snapshot?.phase === "reconnecting";
      },
      undefined,
      { timeout: controlUiE2eWaitTimeoutMs },
    ),
    page
      .locator(".gateway-status__label", { hasText: "Reconnecting…" })
      .waitFor({ state: "visible", timeout: controlUiE2eWaitTimeoutMs }),
  ]);
}

/** Wait for the lazy terminal itself before exercising a real keyboard shortcut. */
export async function waitForControlUiTerminalReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (
        document.querySelector("openclaw-terminal-panel") as
          | (HTMLElement & { available?: boolean })
          | null
      )?.available === true,
  );
}

/**
 * Wait for the settled in-app confirmation modal. Control UI routes destructive
 * confirms through `showConfirmDialog`, so no native browser dialog ever fires;
 * waiting for full opacity keeps the click from landing mid-animation.
 */
export async function waitForConfirmModal(page: Page): Promise<Locator> {
  await page.waitForFunction(() => {
    const modal = [...document.querySelectorAll("openclaw-modal-dialog")].at(-1);
    const dialog = modal?.shadowRoot
      ?.querySelector("wa-dialog")
      ?.shadowRoot?.querySelector("dialog");
    return Boolean(dialog) && getComputedStyle(dialog as Element).opacity === "1";
  });
  return page.locator("openclaw-modal-dialog").last();
}
