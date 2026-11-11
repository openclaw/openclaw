import { expect, it, onTestFinished } from "vitest";
import { page } from "vitest/browser";
import { formatEd25519PublicKey } from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ensureOwnerDeviceSigner } from "../../lib/openclaw-id/device-key.ts";
import { startOpenClawIdFeatureLifetime } from "../../lib/openclaw-id/feature-lifetime.ts";
import "../../styles.css";
import { showOwnerDevicesDialog } from "./owner-devices-dialog.tsx";

it.each([390, 1440])("keeps removal actions inside their row at %s px", async (width) => {
  const viewport = { width: innerWidth, height: innerHeight };
  onTestFinished(() => page.viewport(viewport.width, viewport.height));
  await page.viewport(width, 900);
  onTestFinished(startOpenClawIdFeatureLifetime());
  const clawId = "removal-layout";
  const own = formatEd25519PublicKey((await ensureOwnerDeviceSigner(clawId)).publicKey);
  const ownerDevices = [
    { devicePub: own, label: "This browser", peerKeys: [], approvedBy: "root" },
    {
      devicePub: `ed25519:${"11".repeat(32)}`,
      label: "Chrome on Windows 11",
      peerKeys: [],
      approvedBy: "root",
    },
  ];
  const done = showOwnerDevicesDialog({
    client: {
      request: async (method: string) =>
        method === "openclawId.people"
          ? { link: { linked: true, clawId, ownerDevices } }
          : { channel: "tunnel" },
    } as unknown as GatewayBrowserClient,
  });
  onTestFinished(async () => {
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await done;
  });
  const remove = page.getByRole("button", { name: "Remove access", exact: true });
  await expect.element(remove).toBeVisible();
  const row = remove.element().closest<HTMLElement>('[role="listitem"]')!;
  const label = row.querySelector<HTMLElement>(".openclaw-id-devices__text")!;
  await Promise.all(document.getAnimations().map((animation) => animation.finished));
  const initial = label.getBoundingClientRect();
  const initialRow = row.getBoundingClientRect();
  await remove.click();
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  const confirm = page.getByRole("button", {
    name: "Remove access for Chrome on Windows 11",
    exact: true,
  });
  await expect.element(cancel).toBeVisible();
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
});
