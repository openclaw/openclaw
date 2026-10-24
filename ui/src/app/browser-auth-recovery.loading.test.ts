/* @vitest-environment jsdom */

import { getByRole } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { startBrowserAuthRecovery } from "./browser-auth-recovery.tsx";
import { fetchControlUiResource } from "./browser-http.ts";

// mock-isolation: Simulate a failed lazy download before the module has any exports.
vi.mock("./browser-auth-recovery-dialog.tsx", () => {
  throw new Error("Synthetic sign-in dialog chunk unavailable");
});

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock("./browser-auth-recovery-dialog.tsx");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("retains sign-in and retry actions when the recovery dialog import fails", async () => {
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
      expect(getByRole(document.body, "button", { name: "Retry" })).toBeTruthy(),
    );
    expect(getByRole(document.body, "alert").textContent).toContain("Panel failed to load");
    getByRole(document.body, "button", { name: "Sign in" }).click();
    expect(opened).toHaveBeenCalledExactlyOnceWith(
      `${window.location.origin}/nested/`,
      "_blank",
      "noopener,noreferrer",
    );
    vi.doUnmock("./browser-auth-recovery-dialog.tsx");
    getByRole(document.body, "button", { name: "Retry" }).click();
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
