import type { GatewayBrowserClient } from "../../api/gateway.ts";

/** Open the signing surface on this owner device; a notice itself grants nothing. */
export async function openBrowserRequestApproval(
  client: GatewayBrowserClient | null | undefined,
  remote: boolean,
  current: () => boolean,
): Promise<void> {
  if (!current()) {
    return;
  }
  if (remote) {
    window.location.assign("/_loader/?stay=1&view=approve");
    return;
  }
  const [{ showOwnerApprovalDialog }, { showOwnerDevicesDialog }] = await Promise.all([
    import("../../components/openclaw-id/owner-approval-dialog.tsx"),
    import("../../components/openclaw-id/owner-devices-dialog.tsx"),
  ]);
  if (client && current()) {
    await showOwnerApprovalDialog({
      client,
      onDevices: () => void showOwnerDevicesDialog({ client }),
    });
  }
}
