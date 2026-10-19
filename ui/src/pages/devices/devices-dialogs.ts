import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { showConfirmDialog, type ConfirmDialogOptions } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type {
  DevicesPageDataState,
  InventoryRemovalRequest,
} from "../../lib/nodes/page-operations.ts";
import {
  rejectDevicePairing,
  rejectNodePairingRequest,
  removeInventoryEntry,
  removeStaleInventoryEntries,
  renameDevice,
  revokeDeviceToken,
} from "../../lib/nodes/page-operations.ts";

registerDevicesEnglish();

type DeviceAliasTarget = {
  id: string;
  name: string;
  operatorLabel?: string;
};

type InventoryRemovalPrompt =
  | { kind: "entry"; entry: InventoryRemovalRequest }
  | { kind: "stale"; entries: InventoryRemovalRequest[] };

export type DevicesDialogHost = {
  canManagePairing: () => boolean;
  gatewayConnected: () => boolean;
  gatewayClient: () => GatewayBrowserClient | null;
  gatewayUrl: () => string;
  runPageTask: <T>(task: (pageState: DevicesPageDataState) => T | Promise<T>) => Promise<T>;
  setDevicesError: (message: string) => void;
};

export function createDevicesDialogs(host: DevicesDialogHost) {
  let pending: AbortController | null = null;

  function cancel() {
    pending?.abort();
    pending = null;
  }

  // Alias edits and destructive confirmations share one identity-scoped slot.
  async function editAlias(device: DeviceAliasTarget): Promise<void> {
    if (!host.canManagePairing() || pending) {
      return;
    }
    const controller = new AbortController();
    pending = controller;
    try {
      const { showInputDialog } = await import("../../components/input-dialog.ts");
      await showInputDialog({
        signal: controller.signal,
        title: t("devices.inventory.renameTitle", { name: device.name }),
        label: t("devices.inventory.renamePrompt"),
        defaultValue: device.operatorLabel ?? "",
        requireValue: true,
        requireChange: true,
        canSubmit: host.canManagePairing,
        submit: (label) => {
          if (!host.canManagePairing()) {
            return Promise.resolve(t("devices.readOnly.pairingRequired"));
          }
          return host.runPageTask((pageState) =>
            renameDevice(pageState, { deviceId: device.id, label }),
          );
        },
      });
    } catch (error) {
      host.setDevicesError(formatUiError(error));
    } finally {
      if (pending === controller) {
        pending = null;
      }
    }
  }

  function confirmInventoryRemoval(prompt: InventoryRemovalPrompt): Promise<void> {
    return confirmDestructiveAction(
      {
        confirmLabel: t("devices.inventory.remove"),
        ...(prompt.kind === "entry"
          ? {
              title: t("devices.inventory.removePromptTitle", { name: prompt.entry.name }),
              message: t("devices.inventory.removePromptBody"),
              details: t("devices.inventory.deviceId", { id: prompt.entry.id }),
            }
          : {
              title: t(
                prompt.entries.length === 1
                  ? "devices.inventory.removeStalePromptTitleOne"
                  : "devices.inventory.removeStalePromptTitle",
                { count: String(prompt.entries.length) },
              ),
              message: t("devices.inventory.removeStalePromptBody"),
            }),
      },
      prompt.kind === "entry"
        ? (pageState) => removeInventoryEntry(pageState, prompt.entry)
        : (pageState) => removeStaleInventoryEntries(pageState, prompt.entries),
    );
  }

  function confirmPairingReject(target: "device" | "node", requestId: string): Promise<void> {
    return confirmDestructiveAction(
      {
        title: t(
          target === "device"
            ? "devices.inventory.rejectDevicePromptTitle"
            : "devices.inventory.rejectNodePromptTitle",
        ),
        message: t("devices.inventory.rejectPromptBody"),
        confirmLabel: t("devices.inventory.reject"),
      },
      (pageState) =>
        target === "device"
          ? rejectDevicePairing(pageState, requestId)
          : rejectNodePairingRequest(pageState, requestId),
    );
  }

  function confirmTokenRevoke(deviceId: string, role: string): Promise<void> {
    return confirmDestructiveAction(
      {
        title: t("devices.inventory.revokePromptTitle", { role }),
        message: t("devices.inventory.revokePromptBody"),
        details: t("devices.inventory.deviceId", { id: deviceId }),
        confirmLabel: t("devices.inventory.revoke"),
      },
      (pageState) =>
        revokeDeviceToken(pageState, {
          deviceId,
          gatewayUrl: host.gatewayUrl(),
          role,
        }),
    );
  }

  /**
   * Switching the exec approvals target throws away an unsaved policy draft, so
   * it confirms through the same single-dialog slot as the destructive actions:
   * an identity change aborts it and it cannot stack on another prompt. There is no
   * request to place, so the post-await revalidation is only that this dialog is
   * still the page's current one — a false result must leave every field alone.
   */
  async function confirmExecApprovalsDiscard(): Promise<boolean> {
    if (pending) {
      return false;
    }
    const controller = new AbortController();
    pending = controller;
    const confirmed = await showConfirmDialog({
      title: t("devices.execApprovals.discardPromptTitle"),
      message: t("devices.execApprovals.discardPromptBody"),
      confirmLabel: t("devices.execApprovals.discardConfirm"),
      danger: true,
      signal: controller.signal,
    });
    if (pending === controller) {
      pending = null;
    }
    return confirmed && !controller.signal.aborted;
  }

  // Every destructive Devices action confirms here, never through window.confirm: the
  // awaited dialog lets the gateway reconnect or swap clients mid-prompt, so the captured
  // identity and current authority are revalidated before the operation runs.
  async function confirmDestructiveAction(
    prompt: Omit<ConfirmDialogOptions, "danger" | "signal">,
    run: (pageState: DevicesPageDataState) => unknown,
  ) {
    if (!host.canManagePairing() || pending) {
      return;
    }
    const controller = new AbortController();
    pending = controller;
    const client = host.gatewayClient();
    const confirmed = await showConfirmDialog({
      ...prompt,
      danger: true,
      signal: controller.signal,
      canConfirm: host.canManagePairing,
    });
    if (pending === controller) {
      pending = null;
    }
    if (
      !confirmed ||
      controller.signal.aborted ||
      client !== host.gatewayClient() ||
      !host.gatewayConnected() ||
      !host.canManagePairing()
    ) {
      return;
    }
    await host.runPageTask(run);
  }
  return {
    cancel,
    editAlias,
    confirmInventoryRemoval,
    confirmPairingReject,
    confirmTokenRevoke,
    confirmExecApprovalsDiscard,
  };
}
