import "../../styles.css";
import "../modal-dialog.tsx";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { requestResult, transactionComplete } from "../../lib/chat/control-ui-database.runtime.ts";
import { startOpenClawIdFeatureLifetime } from "../../lib/openclaw-id/feature-lifetime.ts";
import type { OpenClawIdPublication } from "../../lib/openclaw-id/types.ts";
import { emulateOverlayMedia } from "../../test-helpers/overlay-browser-media.ts";
import { showMakeReachableDialog } from "./make-reachable-dialog.tsx";

let endFeature = () => {};
let clawId: string;
let storedDevice = false;

afterEach(async () => {
  endFeature();
  vi.restoreAllMocks();
  await emulateOverlayMedia({ reducedMotion: "no-preference" });
  // Remove only this flow's real browser key, retaining any other test's custody.
  if (storedDevice) {
    const db = await requestResult(indexedDB.open("openclaw-id", 1));
    try {
      const transaction = db.transaction("owner-devices", "readwrite");
      transaction.objectStore("owner-devices").delete(clawId);
      await transactionComplete(transaction);
    } finally {
      db.close();
    }
  }
});

function entrance(element: Element, duration: number, easing: string) {
  const effect = element.getAnimations()[0]?.effect as KeyframeEffect | undefined;
  expect(effect?.getTiming()).toMatchObject({ duration, fill: "both" });
  expect(effect?.getKeyframes()[0]).toMatchObject({ opacity: "0", translate: "0px 4px", easing });
}

it.each([false, true])(
  "animates the real setup flow while retaining its anchor and controls (reduced: %s)",
  async (reduced) => {
    await emulateOverlayMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
    endFeature = startOpenClawIdFeatureLifetime();
    clawId = crypto.randomUUID();
    storedDevice = false;
    const key = await generateEd25519Signer();
    const commit = Promise.withResolvers<{ publication: OpenClawIdPublication }>();
    const request = vi.fn(async (_method: string, params: { action?: string; name?: string }) => {
      if (params.action === "check_name") {
        return { name: params.name, hostname: "studio-test.claws.test", available: true };
      }
      if (params.action === "prepare") {
        return {
          claw_id: clawId,
          hostname: "studio-test.claws.test",
          k_srv: formatIrohEndpointKey(key.publicKey),
          k_gw: formatEd25519PublicKey(key.publicKey),
          binding_seq: 1,
          root_epoch: 1,
        };
      }
      if (params.action === "commit") {
        storedDevice = true;
        return commit.promise;
      }
      return { status: { state: "on", tunnel: { state: "running", relayOnline: true } } };
    });
    const done = showMakeReachableDialog({
      client: { request } as unknown as GatewayBrowserClient,
      loaderDomain: "claws.test",
    });
    const dialog = await vi.waitFor(() => {
      const element = document.querySelector<HTMLDialogElement>("dialog[open]");
      expect(element).not.toBeNull();
      return element!;
    });
    await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
    const body = dialog.querySelector<HTMLElement>(".oc-dialog__body")!;
    const title = dialog.querySelector("h2")!;
    const top = title.getBoundingClientRect().top;
    const close = dialog.querySelector<HTMLButtonElement>(".oc-dialog__close")!;
    const closeWidth = close.getBoundingClientRect().width;
    const morphs = vi.spyOn(body, "animate");
    await userEvent.fill(
      page.getByRole("textbox", { name: "Link code", exact: true }),
      "test-code",
    );
    await userEvent.fill(page.getByRole("textbox", { name: "Claw name", exact: true }), "studio");
    await userEvent.tab();
    await expect.element(page.getByText(/Available:.*studio-test/)).toBeVisible();
    entrance(body.querySelector("#openclaw-id-name-status > span")!, reduced ? 0.01 : 200, "ease");

    await userEvent.click(page.getByRole("button", { name: "Continue", exact: true }));
    await expect.element(page.getByRole("checkbox")).toBeVisible();
    entrance(
      body.querySelector(".openclaw-id-kit__lead")!,
      reduced ? 0.01 : 220,
      "cubic-bezier(0.2, 0.8, 0.2, 1)",
    );
    expect(title.getBoundingClientRect().top).toBe(top);
    vi.spyOn(window, "open").mockReturnValue(null);
    await userEvent.click(page.getByRole("button", { name: "Print or save as PDF", exact: true }));
    await vi.waitFor(() => {
      const note = body.querySelector("#openclaw-recovery-kit > .openclaw-id-setup__status > div");
      expect(note).not.toBeNull();
      entrance(note!, reduced ? 0.01 : 200, "ease");
    });
    await userEvent.click(page.getByRole("checkbox"));
    await userEvent.click(page.getByRole("button", { name: "Continue", exact: true }));
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([, params]) => params.action === "commit")).toBe(true),
    );
    entrance(
      body.querySelector('[role="status"]')!,
      reduced ? 0.01 : 220,
      "cubic-bezier(0.2, 0.8, 0.2, 1)",
    );
    expect(dialog.querySelector(".oc-dialog__close")).toBe(close);
    expect(close.disabled).toBe(true);
    expect(close.getBoundingClientRect().width).toBe(closeWidth);
    await vi.waitFor(() => expect(getComputedStyle(close).opacity).toBe("0"));
    expect(getComputedStyle(close).pointerEvents).toBe("none");
    const spinner = body.querySelector(".openclaw-id-setup__spinner")!;
    expect(getComputedStyle(spinner).animationDuration).toBe(reduced ? "2.4s" : "0.9s");
    expect(getComputedStyle(spinner).animationIterationCount).toBe("infinite");

    commit.resolve({
      publication: { state: "failed", code: "unavailable", message: "HTTP 503", retryable: true },
    });
    await expect.element(page.getByText(/This claw will keep trying/)).toBeVisible();
    const message = body.querySelector(".openclaw-id-steps__message")!;
    entrance(message, reduced ? 0.01 : 200, "ease");
    const mark = body.querySelector(
      '.openclaw-id-steps__item[data-state="warning"] .openclaw-id-steps__mark',
    )!;
    const pop = mark.getAnimations()[0]?.effect as KeyframeEffect | undefined;
    expect(pop?.getTiming()).toMatchObject({
      duration: reduced ? 0.01 : 260,
    });
    expect(pop?.getKeyframes()[0]).toMatchObject({
      opacity: "0",
      scale: "0.6",
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    });
    expect(title.getBoundingClientRect().top).toBe(top);
    if (reduced) {
      expect(morphs).not.toHaveBeenCalled();
    } else {
      const heights = morphs.mock.results.map((result) => result.value as Animation);
      expect(heights.length).toBeGreaterThanOrEqual(2);
      for (const animation of heights) {
        expect(animation.effect?.getTiming()).toMatchObject({
          duration: 240,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        });
      }
    }
    await userEvent.click(page.getByRole("button", { name: "Done", exact: true }));
    expect(await done).toBe(true);
  },
);
