import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { startOpenClawIdFeatureLifetime } from "../../lib/openclaw-id/feature-lifetime.ts";
import { showOwnerApprovalDialog } from "./owner-approval-dialog.tsx";
import "../../styles.css";

const fixture = vi.hoisted(() => ({ decide: vi.fn() }));
// mock-isolation: this presentation proof supplies the browser-owned request, not membership authority.
vi.mock("../../lib/openclaw-id/owner-approval-lifetime.ts", () => ({
  ownerApprovalFor: () => ({
    read: () => ({
      ready: true,
      error: null,
      requests: [
        {
          id: "synthetic-member",
          label: "Firefox on Linux",
          code: "482917",
          busy: false,
          member: { name: "Alice Example", email: "alice@example.test", location: "Example City" },
        },
      ],
    }),
    subscribe: () => () => {},
    decide: fixture.decide,
  }),
}));
afterEach(() => {
  document.body.replaceChildren();
  fixture.decide.mockReset();
});

it.each(["light", "dark"])("requires member-read code in the %s owner dialog", async (theme) => {
  await page.viewport(1040, 900);
  document.documentElement.dataset.theme = theme;
  const stop = startOpenClawIdFeatureLifetime();
  // SAFETY: the mocked approval owner is the only consumer of this client in this presentation proof.
  const done = showOwnerApprovalDialog({ client: {} as GatewayBrowserClient, onDevices: vi.fn() });
  try {
    await expect
      .poll(() => document.body.textContent)
      .toContain("This browser says they are Alice Example");
    const approve = () =>
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "The numbers match",
      )!;
    expect(approve().disabled).toBe(true);
    expect(document.querySelector('input[type="number"]')).toBeNull();
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
    await page.screenshot({
      path: `./.vitest/ocf551/owner-member-code-${theme}.png`,
    });
    const input = document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
    input.value = "000000";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => approve().disabled).toBe(true);
    expect(fixture.decide).not.toHaveBeenCalled();
    input.value = "482917";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => approve().disabled).toBe(false);
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
    await page.screenshot({
      path: `./.vitest/ocf551/owner-member-compared-${theme}.png`,
    });
    approve().click();
    expect(fixture.decide).toHaveBeenCalledWith("synthetic-member", true, null, "482917");
  } finally {
    document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
    await done;
    stop();
  }
});
