// Persistent local-owner notifications reuse the sidebar's admitted Gateway lifetime.
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
  void import("./owner-approval-lifetime.ts")
    .then(({ bindOwnerApproval }) => {
      if (disposed) {
        return;
      }
      stop = bindOwnerApproval(gateway, (client) =>
        showToast({
          severity: "info",
          message: t("openclawId.approvalNotice"),
          actionLabel: t("openclawId.approveNewDevice"),
          durationMs: 30_000,
          onAction: () => {
            // The toast outlives this binding; once the feature is off it opens nothing.
            if (disposed) {
              return;
            }
            void import("../../components/openclaw-id/owner-approval-dialog.tsx")
              .then(({ showOwnerApprovalDialog }) => {
                if (!disposed) {
                  void showOwnerApprovalDialog({
                    client,
                    onDevices: () => {
                      if (disposed) {
                        return;
                      }
                      void import("../../components/openclaw-id/owner-devices-dialog.tsx")
                        .then(({ showOwnerDevicesDialog }) =>
                          disposed ? undefined : showOwnerDevicesDialog({ client }),
                        )
                        .catch((error: unknown) =>
                          showToast({
                            severity: "error",
                            message: openClawIdErrorToast(error, "open"),
                          }),
                        );
                    },
                  });
                }
              })
              .catch((error: unknown) =>
                showToast({
                  severity: "error",
                  message: openClawIdErrorToast(error, "open"),
                }),
              );
          },
        }),
      );
    })
    .catch((error: unknown) => {
      if (!disposed) {
        showToast({ severity: "error", message: openClawIdErrorToast(error, "open") });
      }
    });
  return () => {
    disposed = true;
    stop();
  };
}
