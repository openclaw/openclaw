/* @vitest-environment jsdom */

import { getByRole } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { startBrowserAuthRecovery } from "./browser-auth-recovery.tsx";
import { fetchControlUiResource } from "./browser-http.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock("./browser-auth-recovery-dialog.tsx");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the sign-in explanation loaded before the proxy stops serving chunks", async () => {
  // The entry module loaded while signed in; subsequent chunk requests are now refused.
  // mock-isolation: reject late dialog imports to prove the already-loaded explanation survives lost chunk access.
  vi.doMock("./browser-auth-recovery-dialog.tsx", () => {
    throw new Error("Synthetic sign-in dialog chunk unavailable");
  });
  const restoreDialog = installDialogPolyfill();
  const opened = vi.spyOn(window, "open").mockReturnValue(null);
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "HEAD") {
      return Object.defineProperty(new Response(null, { status: 302 }), "type", {
        value: "opaqueredirect",
      });
    }
    throw new TypeError("Failed to fetch");
  });
  const stop = startBrowserAuthRecovery("/nested");
  try {
    await expect(fetchControlUiResource("/nested/file")).rejects.toThrow("Failed to fetch");
    await waitForSolid(() => expect(document.querySelector("iframe")).not.toBeNull());
    document.querySelector("iframe")!.dispatchEvent(new Event("load"));
    await waitForSolid(() =>
      expect(document.body.textContent).toContain("Your website sign-in has expired."),
    );
    expect(document.body.textContent).not.toContain("Panel failed to load");
    getByRole(document.body, "button", { name: "Sign in" }).click();
    expect(opened).toHaveBeenCalledExactlyOnceWith(
      `${window.location.origin}/nested/`,
      "_blank",
      "noopener,noreferrer",
    );
    await waitForSolid(() =>
      expect(document.body.textContent).toContain("Finish signing in in the new tab"),
    );
    getByRole(document.body, "button", { name: "Not now" }).click();
    await waitForSolid(() => expect(document.querySelector("openclaw-modal-dialog")).toBeNull());
  } finally {
    stop();
    restoreDialog();
  }
});
