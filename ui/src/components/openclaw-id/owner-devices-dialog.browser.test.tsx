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
    const device = (devicePub: string, label: string, deviceFp: string, approvedBy = "root") => ({
      devicePub,
      label,
      deviceFp,
      peerKeys: [],
      approvedBy,
    });
    let ownerDevices = [
      device(own, "This browser", "fp:own"),
      device(`ed25519:${"11".repeat(32)}`, "Chrome on Windows 11", "fp:windows"),
      device(`ed25519:${"22".repeat(32)}`, "Tablet", "fp:tablet", "fp:windows"),
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
    await Promise.allSettled(
      dialog.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
    const contentOffset = () => {
      const rowBounds = row.getBoundingClientRect();
      const labelBounds = label.getBoundingClientRect();
      return [labelBounds.left - rowBounds.left, labelBounds.top - rowBounds.top];
    };
    const initialOffset = contentOffset();
    const heightAnimations = new Map<Element, Animation>();
    const rowOffsets: number[][] = [];
    // Capture at the style-mutation checkpoint, before timers or the click RPC can resume.
    // Finishing here forces the slow-observer case: live getAnimations() has already expired.
    const observer = new MutationObserver(() => {
      for (const animation of dialog.getAnimations({ subtree: true })) {
        const effect = animation.effect;
        if (
          !(effect instanceof KeyframeEffect) ||
          !effect.getKeyframes().some((frame) => frame.height !== undefined)
        ) {
          continue;
        }
        heightAnimations.set(effect.target!, animation);
        if (effect.target === row && rowOffsets.length === 0) {
          for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
            animation.currentTime = Number(effect.getTiming().duration) * progress;
            rowOffsets.push(contentOffset());
          }
        }
        animation.finish();
      }
    });
    observer.observe(dialog, { subtree: true, attributes: true, attributeFilter: ["style"] });
    onTestFinished(() => observer.disconnect());
    const heightAnimation = (element: HTMLElement) => heightAnimations.get(element);
    await remove.click();
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    const confirm = page.getByRole("button", {
      name: "Remove access for Chrome on Windows 11",
      exact: true,
    });
    await expect.element(cancel).toBeVisible();
    if (!reduced) {
      await vi.waitFor(() => expect(heightAnimation(row)).toBeDefined(), { interval: 5 });
      expect(rowOffsets).toEqual(Array.from({ length: 5 }, () => initialOffset));
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
    expect(contentOffset()).toEqual(initialOffset);
    const card = row.closest<HTMLElement>(".openclaw-id-devices")!;
    const security = page.getByRole("button", { name: "Security details", exact: true });
    const section = document.getElementById(security.element().getAttribute("aria-controls")!)!;
    for (const open of [true, false]) {
      heightAnimations.clear();
      await security.click();
      if (!reduced) {
        await vi.waitFor(() => expect(heightAnimation(section)).toBeDefined(), { interval: 5 });
        expect(heightAnimation(card)).toBeDefined();
        expect(heightAnimation(section)?.playState).toBe("finished");
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
    heightAnimations.clear();
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
