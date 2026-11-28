import { showConfirmChoiceDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../lib/reactive/i18n.ts";

/** Closing needs the edit decision; setup still waits for its follow-up reads. */
export function createChannelConfigNavigation(owner: {
  selectedChannel: () => string | null;
  hasUnsavedConfig: (id: string) => boolean;
  label: (id: string) => string;
  saveChannelConfig: (id: string, onSaved?: () => void) => Promise<boolean>;
  discardChannelConfig: (id: string, onDiscarded?: () => void) => Promise<void>;
  clearChannelDetail: () => void;
}) {
  async function resolveUnsavedConfig(channelId: string, onResolved?: () => void) {
    const channel = owner.label(channelId);
    const choice = await showConfirmChoiceDialog({
      title: t("channels.config.unsavedTitle", { channel }),
      message: t("channels.config.unsavedMessage", { channel }),
      confirmLabel: t("common.save"),
      alternativeLabel: t("channels.config.discard"),
      cancelLabel: t("channels.config.keepEditing"),
    });
    if (choice === "alternative") {
      await owner.discardChannelConfig(channelId, onResolved);
      return true;
    }
    return choice === "confirm" ? owner.saveChannelConfig(channelId, onResolved) : false;
  }

  function closeChannelDetail() {
    const channelId = owner.selectedChannel();
    if (channelId && owner.hasUnsavedConfig(channelId)) {
      void resolveUnsavedConfig(channelId, () => {
        if (owner.selectedChannel() === channelId) {
          owner.clearChannelDetail();
        }
      });
    } else {
      owner.clearChannelDetail();
    }
  }

  return { closeChannelDetail, resolveUnsavedConfig };
}
