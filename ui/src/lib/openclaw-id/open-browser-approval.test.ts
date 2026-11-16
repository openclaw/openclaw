import { afterEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context-types.ts";
import { openOwnerInboxAction } from "./open-browser-approval.ts";
const hooks = vi.hoisted(() => ({ approve: vi.fn(), recover: vi.fn(), devices: vi.fn() }));
// mock-isolation: observe modal entry and recovery failures without live Gateway or DOM owners.
vi.mock("../../components/openclaw-id/owner-approval-dialog.tsx", () => ({
  showOwnerApprovalDialog: hooks.approve,
}));
vi.mock("../../components/openclaw-id/owner-devices-dialog.tsx", () => ({
  showOwnerDevicesDialog: hooks.devices,
}));
vi.mock("../../components/openclaw-id/key-attention.ts", () => ({
  openSidebarKeyRecovery: hooks.recover,
}));
afterEach(() => vi.resetAllMocks());
const refresh = vi.fn();
const client = {};
// SAFETY: the action reads only the captured Gateway client and Inbox refresh owner.
const context = {
  gateway: { snapshot: { client } },
  sidebarAttention: { refreshOpenClawId: refresh },
} as unknown as ApplicationContext;
it("opens a local approval only while the captured Inbox presentation is current", async () => {
  const action = { kind: "openClawIdBrowserApproval" as const, remote: false, label: "Approve" };
  await openOwnerInboxAction(context, action, () => false);
  expect(hooks.approve).not.toHaveBeenCalled();
  await openOwnerInboxAction(
    context,
    action,
    vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false),
  );
  expect(hooks.approve).not.toHaveBeenCalled();
  await openOwnerInboxAction(context, action, () => true);
  expect(hooks.approve).toHaveBeenCalledWith({ client, onDevices: expect.any(Function) });
  expect(refresh).not.toHaveBeenCalled();
});
it("propagates recovery failure to the action owner", async () => {
  const failure = new Error("Recovery unavailable");
  hooks.recover.mockRejectedValueOnce(failure);
  await expect(
    openOwnerInboxAction(context, { kind: "openClawIdRecovery", label: "Recover" }, () => true),
  ).rejects.toBe(failure);
  expect(hooks.recover).toHaveBeenCalledWith(context);
  expect(refresh).not.toHaveBeenCalled();
});
