/* @vitest-environment jsdom */
import "../modal-dialog.tsx";
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { startNativeLinkRouting } from "../../app/native-link-routing.ts";
import { startOpenClawIdFeatureLifetime } from "../../lib/openclaw-id/feature-lifetime.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../panel-toggle-contract.ts";
import { showDeviceSignInDialog } from "./device-sign-in-dialog.tsx";

const verificationUrl = "https://id.example.test/device?user_code=ABCD-EFGH";

afterEach(() => {
  cleanupSolid();
  vi.unstubAllGlobals();
});

it("opens OpenClaw ID in the system browser, not the in-app browser panel", async () => {
  const endFeature = startOpenClawIdFeatureLifetime();
  const postLink = vi.fn();
  vi.stubGlobal("webkit", {
    messageHandlers: {
      openclawLink: { postMessage: postLink },
      openclawBrowser: { postMessage: vi.fn() },
    },
  });
  const routing = startNativeLinkRouting();
  const panelRequests = vi.fn();
  window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, panelRequests);
  const client = {
    request: vi.fn(async () => ({
      state: "state",
      userCode: "ABCD-EFGH",
      verificationUri: "https://id.example.test/device",
      verificationUriComplete: verificationUrl,
      expiresAt: Date.now() + 600_000,
      interval: 600,
    })),
  } as unknown as GatewayBrowserClient;
  try {
    const closed = showDeviceSignInDialog({ client, basePath: "" });
    const link = await vi.waitFor(() => {
      const anchor = document.querySelector<HTMLAnchorElement>(`a[href="${verificationUrl}"]`);
      expect(anchor).not.toBeNull();
      return anchor!;
    });

    const click = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(postLink).toHaveBeenCalledExactlyOnceWith({
      type: "open-link",
      url: verificationUrl,
      target: "external",
    });
    expect(panelRequests).not.toHaveBeenCalled();
    endFeature();
    await expect(closed).resolves.toBeNull();
  } finally {
    window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, panelRequests);
    routing.dispose();
    endFeature();
  }
});
