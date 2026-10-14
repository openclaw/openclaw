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
  requestGeneration: () => number;
  gatewayClient: () => GatewayBrowserClient | null;
  gatewayUrl: () => string;
  runPageTask: <T>(task: (pageState: DevicesPageDataState) => T | Promise<T>) => Promise<T>;
  setDevicesError: (message: string) => void;
};

export class DevicesDialogController {
  private pending: AbortController | null = null;

  constructor(private readonly host: DevicesDialogHost) {}

  cancel() {
    this.pending?.abort();
    this.pending = null;
  }

  // Alias edits and destructive confirmations share one slot, retired on reconnect.
  async editAlias(device: DeviceAliasTarget): Promise<void> {
    if (!this.host.canManagePairing() || this.pending) {
      return;
    }
    const controller = new AbortController();
    this.pending = controller;
    try {
      const { showInputDialog } = await import("../../components/input-dialog.ts");
      await showInputDialog({
        signal: controller.signal,
        title: t("devices.inventory.renameTitle", { name: device.name }),
        label: t("devices.inventory.renamePrompt"),
        defaultValue: device.operatorLabel ?? "",
        requireValue: true,
        requireChange: true,
        submit: (label) => {
          if (!this.host.canManagePairing()) {
            return Promise.resolve(t("devices.readOnly.pairingRequired"));
          }
          return this.host.runPageTask((pageState) =>
            renameDevice(pageState, { deviceId: device.id, label }),
          );
        },
      });
    } catch (error) {
      this.host.setDevicesError(formatUiError(error));
    } finally {
      if (this.pending === controller) {
        this.pending = null;
      }
    }
  }

  confirmInventoryRemoval(prompt: InventoryRemovalPrompt): Promise<void> {
    return this.confirmDestructiveAction(
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

  confirmPairingReject(target: "device" | "node", requestId: string): Promise<void> {
    return this.confirmDestructiveAction(
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

  confirmTokenRevoke(deviceId: string, role: string): Promise<void> {
    return this.confirmDestructiveAction(
      {
        title: t("devices.inventory.revokePromptTitle", { role }),
        message: t("devices.inventory.revokePromptBody"),
        details: t("devices.inventory.deviceId", { id: deviceId }),
        confirmLabel: t("devices.inventory.revoke"),
      },
      (pageState) =>
        revokeDeviceToken(pageState, {
          deviceId,
          gatewayUrl: this.host.gatewayUrl(),
          role,
        }),
    );
  }

  /**
   * Switching the exec approvals target throws away an unsaved policy draft, so
   * it confirms through the same single-dialog slot as the destructive actions:
   * a reconnect aborts it and it cannot stack on another prompt. There is no
   * request to place, so the post-await revalidation is only that this dialog is
   * still the page's current one — a false result must leave every field alone.
   */
  async confirmExecApprovalsDiscard(): Promise<boolean> {
    if (this.pending) {
      return false;
    }
    const controller = new AbortController();
    this.pending = controller;
    const confirmed = await showConfirmDialog({
      title: t("devices.execApprovals.discardPromptTitle"),
      message: t("devices.execApprovals.discardPromptBody"),
      confirmLabel: t("devices.execApprovals.discardConfirm"),
      danger: true,
      signal: controller.signal,
    });
    if (this.pending === controller) {
      this.pending = null;
    }
    return confirmed && !controller.signal.aborted;
  }

  // Every destructive Devices action confirms here, never through window.confirm: the
  // awaited dialog lets the gateway reconnect or swap clients mid-prompt, so the captured
  // scope and current authority are revalidated before the operation runs.
  private async confirmDestructiveAction(
    prompt: Omit<ConfirmDialogOptions, "danger" | "signal">,
    run: (pageState: DevicesPageDataState) => unknown,
  ) {
    if (!this.host.canManagePairing() || this.pending) {
      return;
    }
    const controller = new AbortController();
    this.pending = controller;
    const generation = this.host.requestGeneration();
    const client = this.host.gatewayClient();
    const confirmed = await showConfirmDialog({
      ...prompt,
      danger: true,
      signal: controller.signal,
    });
    if (this.pending === controller) {
      this.pending = null;
    }
    if (
      !confirmed ||
      controller.signal.aborted ||
      generation !== this.host.requestGeneration() ||
      client !== this.host.gatewayClient() ||
      !this.host.gatewayConnected() ||
      !this.host.canManagePairing()
    ) {
      return;
    }
    await this.host.runPageTask(run);
  }
}
