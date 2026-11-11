import { expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import { formatEd25519PublicKey } from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ensureOwnerDeviceSigner } from "../../lib/openclaw-id/device-key.ts";
import { startOpenClawIdFeatureLifetime } from "../../lib/openclaw-id/feature-lifetime.ts";
import { emulateOverlayMedia } from "../../test-helpers/overlay-browser-media.ts";
import "../../styles.css";
import { showOwnerDevicesDialog } from "./owner-devices-dialog.tsx";

it.each([390, 1440].flatMap((width) => [false, true].map((reduced) => ({ width, reduced }))))(
  "animates device changes without moving row content at $width px (reduced: $reduced)",
  async ({ width, reduced }) => {
    await emulateOverlayMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
    onTestFinished(() => emulateOverlayMedia({ reducedMotion: "no-preference" }));
    const viewport = { width: innerWidth, height: innerHeight };
    onTestFinished(() => page.viewport(viewport.width, viewport.height));
    await page.viewport(width, 900);
    onTestFinished(startOpenClawIdFeatureLifetime());
    const clawId = "removal-layout";
    const own = formatEd25519PublicKey((await ensureOwnerDeviceSigner(clawId)).publicKey);
    let ownerDevices = [
      {
        devicePub: own,
        label: "This browser",
        deviceFp: "fp:own",
        peerKeys: [],
        approvedBy: "root",
      },
      {
        devicePub: `ed25519:${"11".repeat(32)}`,
        label: "Chrome on Windows 11",
        deviceFp: "fp:windows",
        peerKeys: [],
        approvedBy: "root",
      },
      {
        devicePub: `ed25519:${"22".repeat(32)}`,
        label: "Tablet",
        deviceFp: "fp:tablet",
        peerKeys: [],
        approvedBy: "fp:windows",
      },
    ];
    const submission = Promise.withResolvers<void>();
    const done = showOwnerDevicesDialog({
      client: {
        request: async (method: string) => {
          if (method === "openclawId.authority") {
            await submission.promise;
            ownerDevices = ownerDevices.slice(0, 1);
            return { status: "applied" };
          }
          return method === "openclawId.people"
            ? { link: { linked: true, clawId, seq: 1, rootPub: own, ownerDevices } }
            : { channel: "tunnel" };
        },
      } as unknown as GatewayBrowserClient,
    });
    onTestFinished(async () => {
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await done;
    });
    const remove = page
      .getByRole("listitem")
      .filter({ has: page.getByText("Chrome on Windows 11", { exact: true }) })
      .getByRole("button", { name: "Remove access", exact: true });
    await expect.element(remove).toBeVisible();
    const row = remove.element().closest<HTMLElement>('[role="listitem"]')!;
    const label = row.querySelector<HTMLElement>(".openclaw-id-devices__text")!;
    const dialog = row.closest<HTMLElement>("openclaw-modal-dialog")!;
    await vi.waitFor(() =>
      expect(
        dialog
          .getAnimations({ subtree: true })
          .some((animation) => animation.pending || animation.playState === "running"),
      ).toBe(false),
    );
    const initial = label.getBoundingClientRect();
    const initialRow = row.getBoundingClientRect();
    await remove.click();
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    const confirm = page.getByRole("button", {
      name: "Remove access for Chrome on Windows 11",
      exact: true,
    });
    await expect.element(cancel).toBeVisible();
    const heightAnimation = (element: HTMLElement) =>
      element
        .getAnimations()
        .find(
          (animation) =>
            animation.effect instanceof KeyframeEffect &&
            animation.effect.getKeyframes().some((frame) => frame.height !== undefined),
        );
    if (!reduced) {
      await vi.waitFor(() => expect(heightAnimation(row)).toBeDefined(), { interval: 5 });
      while (heightAnimation(row)?.playState === "running") {
        const movingRow = row.getBoundingClientRect();
        const movingLabel = label.getBoundingClientRect();
        expect(movingLabel.top - movingRow.top).toBe(initial.top - initialRow.top);
        expect(movingLabel.left - movingRow.left).toBe(initial.left - initialRow.left);
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      }
    }
    await vi.waitFor(() => expect(row.style.height).toBe(""));
    const note = row.querySelector<HTMLElement>('[role="note"]')!.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    const cancelBounds = cancel.element().getBoundingClientRect();
    const confirmBounds = confirm.element().getBoundingClientRect();
    expect(cancelBounds.left).toBeGreaterThanOrEqual(bounds.left);
    expect(confirmBounds.right).toBeLessThanOrEqual(bounds.right);
    expect(cancelBounds.right).toBeLessThan(confirmBounds.left);
    expect(cancelBounds.top).toBeGreaterThanOrEqual(note.bottom);
    expect(confirmBounds.top).toBeGreaterThanOrEqual(note.bottom);
    expect(Math.min(cancelBounds.bottom, confirmBounds.bottom)).toBeGreaterThan(
      Math.max(cancelBounds.top, confirmBounds.top),
    );
    expect(row.scrollWidth).toBe(row.clientWidth);
    const current = label.getBoundingClientRect();
    expect([current.left - bounds.left, current.top - bounds.top]).toEqual([
      initial.left - initialRow.left,
      initial.top - initialRow.top,
    ]);
    const card = row.closest<HTMLElement>(".openclaw-id-devices")!;
    const security = page.getByRole("button", { name: "Security details", exact: true });
    const section = document.getElementById(security.element().getAttribute("aria-controls")!)!;
    for (const open of [true, false]) {
      await security.click();
      if (!reduced) {
        await vi.waitFor(() => expect(heightAnimation(section)).toBeDefined(), { interval: 5 });
        expect(heightAnimation(card)).toBeDefined();
      }
      await vi.waitFor(() => expect(section.style.height).toBe(""));
      expect(section.hidden).toBe(!open);
      expect(getComputedStyle(section).visibility).toBe(open ? "visible" : "hidden");
    }
    const tabletElement = [...document.querySelectorAll<HTMLElement>('[role="listitem"]')].find(
      (element) => element.textContent?.startsWith("Tablet"),
    )!;
    await confirm.click();
    expect(row.isConnected).toBe(true);
    expect(tabletElement.isConnected).toBe(true);
    submission.resolve();
    if (!reduced) {
      await vi.waitFor(
        () => {
          for (const element of [row, tabletElement]) {
            expect(heightAnimation(element)).toBeDefined();
          }
        },
        { interval: 5 },
      );
    }
    await vi.waitFor(() => expect(row.isConnected || tabletElement.isConnected).toBe(false));
    await vi.waitFor(() => expect(card.style.height).toBe(""));
    expect(document.querySelectorAll('[role="listitem"]')).toHaveLength(1);
  },
);
