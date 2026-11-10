/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { startOpenClawIdFeatureLifetime } from "../../lib/openclaw-id/feature-lifetime.ts";
import * as toast from "../../lib/toast.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { showMoveKeysDialog } from "./move-keys-dialog.tsx";

// mock-isolation: kit signing is covered by rebind.test.ts; here the plan is fixed and the
// commit is held open so dismissal can be tried while it runs.
const commit = vi.hoisted(() => ({
  reject: (_error: Error) => {},
  release: () => {},
  calls: [] as string[],
}));
vi.mock("../../lib/openclaw-id/rebind.ts", () => ({
  prepareRebind: async () => ({
    ok: true,
    plan: {
      hostname: "studio.example.test",
      code: "c",
      binding: {},
      root: "ROOT",
      bindingSeq: { from: 1, to: 2 },
      endpoint: { from: "A", to: "B" },
      gateway: { from: "C", to: "D" },
    },
  }),
  commitRebind: () =>
    new Promise<void>((resolve, reject) => {
      commit.reject = reject;
      commit.calls.push("commit");
      commit.release = resolve;
    }),
  cancelRebind: async () => commit.calls.push("cancel"),
}));

const signedIn = { sub: "s", email: null, name: null, exp: 4_102_444_800, idToken: "t" };
let endFeature = () => {};
beforeEach(() => {
  commit.calls.length = 0;
  localStorage.clear();
  localStorage.setItem("openclaw.openclawId.account", JSON.stringify(signedIn));
  window.dispatchEvent(new StorageEvent("storage", { key: "openclaw.openclawId.account" }));
  endFeature = startOpenClawIdFeatureLifetime();
});
afterEach(() => {
  endFeature();
  cleanupSolid();
  vi.restoreAllMocks();
});

async function click(label: string) {
  await vi.waitFor(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label && !candidate.disabled,
    );
    expect(button).toBeDefined();
    button!.click();
  });
}

it("stays open through a running commit and reports the move, never a cancellation", async () => {
  const result = showMoveKeysDialog({
    client: {} as GatewayBrowserClient,
    signedIn: { sub: "s", email: null, name: null, exp: 4_102_444_800, idToken: "t" },
    hostname: "studio.example.test",
  });
  await vi.waitFor(() => expect(document.querySelector("input[type=password]")).not.toBeNull());
  const input = document.querySelector<HTMLInputElement>("input[type=password]")!;
  input.value = "OCK1-synthetic";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await click("Check");
  await click("Move to new keys");
  await vi.waitFor(() => expect(commit.calls).toEqual(["commit"]));
  // Escape or the backdrop while the commit runs: refused, nothing cancelled.
  const dismissal = new Event("modal-cancel", { cancelable: true });
  document.querySelector("openclaw-modal-dialog")!.dispatchEvent(dismissal);
  expect(dismissal.defaultPrevented).toBe(true);
  commit.release();
  expect(await result).toBe(true);
  expect(commit.calls).toEqual(["commit"]);
});

it("discards the confirmation on another tab's account replacement", async () => {
  const result = showMoveKeysDialog({
    client: {} as GatewayBrowserClient,
    signedIn,
    hostname: "studio.example.test",
  });
  await vi.waitFor(() => expect(document.querySelector("input[type=password]")).not.toBeNull());
  const input = document.querySelector<HTMLInputElement>("input[type=password]")!;
  input.value = "OCK1-synthetic";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await click("Check");
  await vi.waitFor(() => expect(document.body.textContent).toContain("ROOT"));
  localStorage.setItem(
    "openclaw.openclawId.account",
    JSON.stringify({ ...signedIn, sub: "other", idToken: "other" }),
  );
  window.dispatchEvent(new StorageEvent("storage", { key: "openclaw.openclawId.account" }));
  expect(await result).toBe(false);
  expect(input.value).toBe("");
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(commit.calls).toEqual([]);
});

it("settles a dispatched commit after Labs is turned off", async () => {
  const notice = vi.spyOn(toast, "showToast").mockReturnValue(true);
  const result = showMoveKeysDialog({
    client: {} as GatewayBrowserClient,
    signedIn,
    hostname: "studio.example.test",
  });
  await vi.waitFor(() => expect(document.querySelector("input[type=password]")).not.toBeNull());
  const input = document.querySelector<HTMLInputElement>("input[type=password]")!;
  input.value = "OCK1-synthetic";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await click("Check");
  await click("Move to new keys");
  await vi.waitFor(() => expect(commit.calls).toEqual(["commit"]));
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  endFeature();
  await Promise.resolve();
  expect(settled).toBe(false);
  commit.reject(new Error("stopped before commit"));
  expect(await result).toBe(false);
  expect(notice).toHaveBeenCalledWith(expect.objectContaining({ severity: "error" }));
});
