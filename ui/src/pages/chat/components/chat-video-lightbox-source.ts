import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { safeMediaAttachmentHref } from "./chat-attachment-href.ts";
import type { ChatMediaPlaybackMode } from "./chat-media-playback.ts";
import { ChatMediaSourceController } from "./chat-media-source.ts";
import {
  observeChatMediaResourceSubscriber,
  releaseChatMediaResourceSubscriber,
  type AttachmentItem,
} from "./chat-message-media.ts";

type VideoSource =
  | {
      status: "available";
      source: { src: string; playback: ChatMediaPlaybackMode; authToken: string | null };
    }
  | { status: "checking" | "unavailable"; onRetry?: () => void };

/** The gallery owns selection; existing attachment/source owners own authorization and playback. */
export function videoLightboxItem(
  attachment: AttachmentItem["attachment"],
  resolveSource: (update: () => void) => VideoSource,
  onRequestUpdate?: () => void,
): ImageLightboxItem {
  return {
    kind: "video",
    // Never put an unchecked local path or expired ticket into the player. The
    // selected item's connection resolves its live source before assigning src.
    src: "",
    title: attachment.label,
    connectVideo: (media, notify, retryFailed = false) => {
      const controller = new ChatMediaSourceController();
      let active = true;
      let retryPending = retryFailed;
      const report = () => {
        if (active) {
          notify(controller.readiness === "idle" ? "preparing" : controller.readiness);
        }
      };
      const refresh = () => {
        if (!active) {
          return;
        }
        const resolved = resolveSource(refresh);
        if (resolved.status !== "available") {
          if (resolved.status === "unavailable" && retryPending && resolved.onRetry) {
            retryPending = false;
            resolved.onRetry();
            return;
          }
          // Expired/revoked authority cannot keep an old player resource alive.
          controller.cancel();
          controller.reset(media);
          notify(
            resolved.status === "checking" ? "preparing" : "unavailable",
            Boolean(resolved.onRetry),
          );
          return;
        }
        const src = safeMediaAttachmentHref(resolved.source.src, "video");
        if (!src) {
          controller.cancel();
          controller.reset(media);
          notify("unavailable", false);
          return;
        }
        const pending = controller.sync(
          media,
          src,
          attachment.url,
          resolved.source.playback,
          resolved.source.authToken,
        );
        report();
        void pending?.then(report);
      };
      if (onRequestUpdate) {
        observeChatMediaResourceSubscriber(onRequestUpdate, refresh);
      }
      const metadata = () => controller.handleLoadedMetadata(media, () => active);
      const adopt = () => {
        controller.applyPendingSource(media);
        report();
      };
      const ended = () => {
        controller.handleEnded(media);
        report();
      };
      const error = () => {
        controller.handleError(media);
        report();
      };
      media.addEventListener("loadedmetadata", metadata);
      media.addEventListener("play", adopt);
      media.addEventListener("seeking", adopt);
      media.addEventListener("ended", ended);
      media.addEventListener("error", error);
      refresh();
      return () => {
        active = false;
        media.removeEventListener("loadedmetadata", metadata);
        media.removeEventListener("play", adopt);
        media.removeEventListener("seeking", adopt);
        media.removeEventListener("ended", ended);
        media.removeEventListener("error", error);
        controller.cancel();
        controller.reset(media);
        releaseChatMediaResourceSubscriber(refresh);
      };
    },
  };
}
