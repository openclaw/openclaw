import type { Locator, Page } from "playwright";
import type { ApplicationGatewayPhase } from "../app/gateway.ts";
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
        const app = document.querySelector("openclaw-app") as
          | (HTMLElement & {
              updateComplete: Promise<boolean>;
              hasUpdated: boolean;
              isUpdatePending: boolean;
              runtime?: {
                documentMode: unknown;
                focusLocation: unknown;
                context?: {
                  gateway?: { snapshot: { phase: ApplicationGatewayPhase } };
                  sessions?: {
                    state: {
                      loading: boolean;
                      result: unknown;
                      resultCached?: boolean;
                    };
                  };
                };
              };
            })
          | null;
        if (!app) {
          return true;
        }
        if (!app.hasUpdated || app.isUpdatePending || !app.runtime) {
          return false;
        }
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        const phase = app.runtime.context?.gateway?.snapshot.phase;
        // Offline mock reloads keep a never-opened socket in "connecting". Read
        // its transport owner; stopped/connecting/starting alone are cold boot.
        if (
          gateway?.online === false ||
          phase === "reconnecting" ||
          phase === "offline" ||
          phase === "reload-required"
        ) {
          return true;
        }
        if (
          app.runtime.documentMode ||
          app.runtime.focusLocation ||
          app.querySelector("openclaw-login-gate")
        ) {
          return true;
        }
        const shell = app.querySelector("openclaw-app-shell") as
          | (HTMLElement & {
              hasUpdated: boolean;
              isUpdatePending: boolean;
              updateComplete: Promise<boolean>;
              navigationSidebar: HTMLElement & {
                navigationVisible?: boolean;
                updateComplete?: Promise<boolean>;
              };
            })
          | null;
        // Root and route splashes precede the shell's navigation decision.
        if (!shell?.hasUpdated || shell.isUpdatePending || !shell.querySelector(".shell")) {
          return false;
        }
        const sidebar = shell.navigationSidebar;
        // app-host creates this element synchronously; app-shell-view mounts it
        // in the first shell render even while its definition is loading. Settings
        // and embed omit it; the owner hides it for onboarding/collapsed/mobile nav.
        if (!sidebar.isConnected || sidebar.navigationVisible === false) {
          return true;
        }
        const state = app.runtime.context?.sessions?.state;
        if (
          !gateway?.initialRosterDelivered ||
          !state?.result ||
          state.loading ||
          state.resultCached ||
          !sidebar?.updateComplete
        ) {
          return false;
        }
        // Playwright treats a Promise as a truthy predicate, even if it resolves false.
        // Return one only after admission; keep the render completion inside its timeout.
        return (async () => {
          await app.updateComplete;
          await shell.updateComplete;
          await sidebar.updateComplete;
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
          return true;
        })();
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
