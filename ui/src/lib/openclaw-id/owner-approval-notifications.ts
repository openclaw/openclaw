// Persistent local-owner notifications reuse the sidebar's admitted Gateway lifetime.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import { registerEnglishCatalog, t } from "../reactive/i18n.ts";
import { showToast } from "../toast.ts";
import { openClawIdErrorToast } from "./ui-error.ts";

/** Installs notification delivery without mounting approval dialogs or retaining any owner keys. */
export function bindOwnerApprovalNotifications(gateway: ApplicationGateway) {
  registerEnglishCatalog(registerOpenClawIdEnglish);
  let disposed = false;
  let stop = () => {};
  const failed = (error: unknown) =>
    showToast({ severity: "error", message: openClawIdErrorToast(error, "open") });
  // Toasts outlive this binding; once the feature is off they open nothing.
  const openDevices = (client: GatewayBrowserClient) => {
    if (disposed) {
      return;
    }
    void import("../../components/openclaw-id/owner-devices-dialog.tsx")
      .then(({ showOwnerDevicesDialog }) =>
        disposed ? undefined : showOwnerDevicesDialog({ client }),
      )
      .catch(failed);
  };
  const openApproval = (client: GatewayBrowserClient) => {
    if (disposed) {
      return;
    }
    void import("../../components/openclaw-id/owner-approval-dialog.tsx")
      .then(({ showOwnerApprovalDialog }) => {
        if (!disposed) {
          void showOwnerApprovalDialog({ client, onDevices: () => openDevices(client) });
        }
      })
      .catch(failed);
  };
  void import("./owner-approval-lifetime.ts")
    .then(({ bindOwnerApproval }) => {
      if (disposed) {
        return;
      }
      stop = bindOwnerApproval(
        gateway,
        (client) =>
          showToast({
            severity: "info",
            message: t("openclawId.approvalNotice"),
            actionLabel: t("openclawId.approveNewDevice"),
            durationMs: 30_000,
            onAction: () => openApproval(client),
          }),
        // The Gateway mails owners when the recovery kit added a device.
        (client, device) =>
          showToast({
            severity: "warning",
            message: device
              ? t("openclawId.kitUsedNotice", { device })
              : t("openclawId.kitUsedNoticeUnknown"),
            description: t("openclawId.kitUsedNoticeBody"),
            actionLabel: t("openclawId.yourDevices"),
            durationMs: 30_000,
            onAction: () => openDevices(client),
          }),
        () =>
          showToast({
            severity: "info",
            message: t("openclawId.memberDeviceAddedNotice"),
            description: t("openclawId.memberDeviceAddedNoticeBody"),
            durationMs: 30_000,
          }),
      );
    })
    .catch((error: unknown) => {
      if (!disposed) {
        failed(error);
      }
    });
  return () => {
    disposed = true;
    stop();
  };
}
