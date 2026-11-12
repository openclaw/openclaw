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
import { showMakeReachableDialog } from "./make-reachable-dialog.tsx";

let endFeature = () => {};
let clawId: string;
let storedDevice = false;

afterEach(async () => {
  endFeature();
  vi.restoreAllMocks();
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

it("retains the setup anchor and gates controls through publication", async () => {
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
  await vi.waitFor(() =>
    expect(
      dialog
        .getAnimations()
        .some((animation) => animation.pending || animation.playState === "running"),
    ).toBe(false),
  );
  const body = dialog.querySelector<HTMLElement>(".oc-dialog__body")!;
  const title = dialog.querySelector("h2")!;
  const top = title.getBoundingClientRect().top;
  const close = dialog.querySelector<HTMLButtonElement>(".oc-dialog__close")!;
  const closeWidth = close.getBoundingClientRect().width;
  await userEvent.fill(page.getByRole("textbox", { name: "Link code", exact: true }), "test-code");
  await userEvent.fill(page.getByRole("textbox", { name: "Claw name", exact: true }), "studio");
  await userEvent.tab();
  await expect.element(page.getByText(/Available:.*studio-test/)).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Continue", exact: true }));
  await expect.element(page.getByRole("checkbox")).toBeVisible();
  expect(title.getBoundingClientRect().top).toBe(top);
  vi.spyOn(window, "open").mockReturnValue(null);
  await userEvent.click(page.getByRole("button", { name: "Print or save as PDF", exact: true }));
  await vi.waitFor(() => {
    const note = body.querySelector("#openclaw-recovery-kit > .openclaw-id-setup__status > div");
    expect(note).not.toBeNull();
  });
  await userEvent.click(page.getByRole("checkbox"));
  await userEvent.click(page.getByRole("button", { name: "Continue", exact: true }));
  await vi.waitFor(() =>
    expect(request.mock.calls.some(([, params]) => params.action === "commit")).toBe(true),
  );
  expect(dialog.querySelector(".oc-dialog__close")).toBe(close);
  expect(close.disabled).toBe(true);
  expect(close.getBoundingClientRect().width).toBe(closeWidth);
  await vi.waitFor(() => expect(getComputedStyle(close).opacity).toBe("0"));
  expect(getComputedStyle(close).pointerEvents).toBe("none");

  commit.resolve({
    publication: { state: "failed", code: "unavailable", message: "HTTP 503", retryable: true },
  });
  await expect.element(page.getByText(/This claw will keep trying/)).toBeVisible();
  expect(title.getBoundingClientRect().top).toBe(top);
  await userEvent.click(page.getByRole("button", { name: "Done", exact: true }));
  expect(await done).toBe(true);
});
