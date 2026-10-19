import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { safeMediaAttachmentHref } from "./chat-attachment-href.ts";
import type { ChatMediaPlaybackMode } from "./chat-media-playback.ts";
import { ChatMediaSourceOwner } from "./chat-media-source.ts";
import {
  observeChatMediaResourceSubscriber,
  releaseChatMediaResourceOwner,
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
  mediaOwner?: object,
): ImageLightboxItem {
  return {
    kind: "video",
    // Never put an unchecked local path or expired ticket into the player. The
    // selected item's connection resolves its live source before assigning src.
    src: "",
    title: attachment.label,
    connectVideo: (media, notify, retryFailed = false) => {
      const controller = new ChatMediaSourceOwner();
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
      if (mediaOwner) {
        observeChatMediaResourceSubscriber(mediaOwner, refresh);
      }
      const metadata = () => controller.handleLoadedMetadata(media, () => active);
      const reportAfter = (update: () => void) => () => {
        update();
        report();
      };
      const adopt = reportAfter(() => controller.applyPendingSource(media));
      const ended = reportAfter(() => controller.handleEnded(media));
      const error = reportAfter(() => controller.handleError(media));
      // The selected lightbox media island owns native playback listeners until disconnect.
      const stopListeners = [
        listen(media, "loadedmetadata", metadata),
        listen(media, "play", adopt),
        listen(media, "seeking", adopt),
        listen(media, "ended", ended),
        listen(media, "error", error),
      ];
      refresh();
      return () => {
        active = false;
        for (const stop of stopListeners) {
          stop();
        }
        controller.cancel();
        controller.reset(media);
        releaseChatMediaResourceOwner(refresh);
      };
    },
  };
}
