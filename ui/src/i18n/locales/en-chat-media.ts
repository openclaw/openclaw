import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatMedia = {
  chat: {
    imageLightbox: {
      loadingDetail: "Loading sharper image…",
      detailFailed: "Preview shown. Sharper image could not load.",
      actions: "Image actions",
      previous: "Previous image",
      next: "Next image",
      position: "{current} / {total}",
      label: "Image preview: {title}",
      open: "Open image {title}",
      openOriginal: "Open in new tab",
      copy: "Copy image",
      download: "Download image",
      copyFailed: "Could not copy this image. Check clipboard access and try again.",
      downloadFailed: "Could not download this image. Try again.",
      loadFailed: "Could not load this image. Try again.",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      resetZoom: "Reset zoom",
      close: "Close image preview",
      untitled: "Image",
    },
    mediaPlayer: {
      play: "Play",
      pause: "Pause",
      seek: "Seek media",
      mute: "Mute",
      unmute: "Unmute",
      volume: "Volume",
      download: "Download {filename}",
      preparing: "Preparing playback…",
      openVideo: "Expand {filename} in the media overlay",
      videoPreview: "Video preview: {title}",
      closeVideoPreview: "Close video preview",
    },
  },
} satisfies TranslationMap;

export const registerChatMediaEnglish = Object.assign(
  () => {
    Object.assign(en.chat.imageLightbox, enChatMedia.chat.imageLightbox);
    Object.assign(en.chat.mediaPlayer, enChatMedia.chat.mediaPlayer);
  },
  { catalog: enChatMedia },
);
