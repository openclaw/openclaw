/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { startOpenClawIdFeatureLifetime } from "../../lib/openclaw-id/feature-lifetime.ts";
import * as toast from "../../lib/toast.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { showUnlinkDialog } from "./unlink-dialog.tsx";

const preview = {
  claw_id: "c".repeat(32),
  hostname: "studio-k7x2q.claws.example.test",
  people: 1,
  devices: 3,
  ownerDevices: 1,
  memberDevices: 2,
  nodes: 0,
};

let endFeature = () => {};
beforeEach(() => {
  endFeature = startOpenClawIdFeatureLifetime();
});
afterEach(() => {
  endFeature();
  cleanupSolid();
  vi.restoreAllMocks();
});

function client(answer: (action: string) => unknown) {
  const actions: string[] = [];
  const request = vi.fn(async (_method: string, params: { action: string; clawId?: string }) => {
    actions.push(params.clawId ? `${params.action}:${params.clawId}` : params.action);
    return answer(params.action);
  });
  // SAFETY: the dialog only calls request("openclawId.authority", ...).
  return { client: { request } as unknown as GatewayBrowserClient, actions };
}

async function click(label: string) {
  await vi.waitFor(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label && !candidate.disabled,
    );
    expect(button).toBeDefined();
    button!.click();
  });
}

it("shows the live counts, the address and the retired name before unlinking", async () => {
  const notice = vi.spyOn(toast, "showToast").mockReturnValue(true);
  const { client: gateway, actions } = client((action) =>
    action === "unlink_preview"
      ? preview
      : { ok: true, unlinked: true, hostname: preview.hostname, discovery: "confirmed" },
  );
  const result = showUnlinkDialog({ client: gateway, hostname: preview.hostname });
  await vi.waitFor(() =>
    expect(document.querySelector("[data-testid=openclaw-id-unlink-warning]")).not.toBeNull(),
  );
  const items = [...document.querySelectorAll("[data-testid=openclaw-id-unlink-warning] li")].map(
    (item) => item.textContent,
  );
  expect(items).toEqual([
    "1 person and 3 devices lose access now. Every member is removed; linking again starts with no one.",
    "https://studio-k7x2q.claws.example.test stops working at once.",
    "The name “studio” can never be used again, by any account, including yours.",
    "Conversations and everything else on this computer stay. You can link it again later as a new claw.",
  ]);
  expect(actions).toEqual(["unlink_preview"]);
  await click("Unlink");
  await expect(result).resolves.toBe(true);
  expect(actions).toEqual(["unlink_preview", `unlink:${preview.claw_id}`]);
  expect(notice).toHaveBeenCalledWith({
    severity: "success",
    message: "studio-k7x2q.claws.example.test is unlinked from OpenClaw ID.",
  });
});

it("unlinks nothing when cancelled, and says when Discovery still needs the unlink", async () => {
  const notice = vi.spyOn(toast, "showToast").mockReturnValue(true);
  const first = client(() => preview);
  const cancelled = showUnlinkDialog({ client: first.client, hostname: preview.hostname });
  await click("Cancel");
  await expect(cancelled).resolves.toBe(false);
  expect(first.actions).toEqual(["unlink_preview"]);
  const second = client((action) =>
    action === "unlink_preview"
      ? preview
      : { ok: true, unlinked: true, hostname: preview.hostname, discovery: "pending" },
  );
  const unlinked = showUnlinkDialog({ client: second.client, hostname: preview.hostname });
  await click("Unlink");
  await expect(unlinked).resolves.toBe(true);
  expect(notice).toHaveBeenCalledWith(
    expect.objectContaining({
      severity: "warning",
      description:
        "OpenClaw ID couldn't be reached. This computer sends the unlink as soon as it can.",
    }),
  );
  const third = client((action) =>
    action === "unlink_preview"
      ? preview
      : { ok: true, unlinked: true, hostname: preview.hostname, discovery: "local_only" },
  );
  const local = showUnlinkDialog({ client: third.client, hostname: preview.hostname });
  await click("Unlink");
  await expect(local).resolves.toBe(true);
  expect(notice).toHaveBeenLastCalledWith({
    severity: "success",
    message: "studio-k7x2q.claws.example.test is unlinked from OpenClaw ID.",
    description: "OpenClaw ID never registered this claw, so it had no address to retire.",
  });
});
