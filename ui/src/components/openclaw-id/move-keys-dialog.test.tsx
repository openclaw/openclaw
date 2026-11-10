/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { startOpenClawIdFeatureLifetime } from "../../lib/openclaw-id/feature-lifetime.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { showMoveKeysDialog } from "./move-keys-dialog.tsx";

// mock-isolation: kit signing is covered by rebind.test.ts; here the plan is fixed and the
// commit is held open so dismissal can be tried while it runs.
const commit = vi.hoisted(() => ({ release: () => {}, calls: [] as string[] }));
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
    new Promise<void>((resolve) => {
      commit.calls.push("commit");
      commit.release = resolve;
    }),
  cancelRebind: async () => commit.calls.push("cancel"),
}));

let endFeature = () => {};
beforeEach(() => (endFeature = startOpenClawIdFeatureLifetime()));
afterEach(() => {
  endFeature();
  cleanupSolid();
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
