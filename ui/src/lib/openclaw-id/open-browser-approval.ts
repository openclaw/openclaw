import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import type { SidebarAttentionItem } from "../../components/sidebar-attention-entries.ts";

/** Owner Inbox actions load only after activation; preserve the captured presentation lifetime. */
export async function openOwnerInboxAction(
  context: ApplicationContext,
  action: Extract<
    SidebarAttentionItem["action"],
    { kind: "openClawIdBrowserApproval" | "openClawIdRecovery" }
  >,
  current: () => boolean,
): Promise<void> {
  if (!current()) return;
  if (action.kind === "openClawIdBrowserApproval") {
    await openBrowserRequestApproval(context.gateway.snapshot.client, action.remote, current);
    return;
  }
  const { openSidebarKeyRecovery } = await import("../../components/openclaw-id/key-attention.ts");
  if (current()) await openSidebarKeyRecovery(context);
}

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
