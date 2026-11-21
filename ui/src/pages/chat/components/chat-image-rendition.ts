import type { ChatImageRenditionWidth } from "../../../../../src/shared/chat-image-renditions.js";

/** Blob-backed authenticated images cannot use native srcset selection. */
export function chatImageRenditionWidth(view: "inline"): 480 | 960;
export function chatImageRenditionWidth(view: "viewer"): ChatImageRenditionWidth;
export function chatImageRenditionWidth(view: "inline" | "viewer"): ChatImageRenditionWidth {
  const density = Math.min(window.devicePixelRatio || 1, 2);
  const pixels =
    view === "inline" ? 400 * density : Math.max(window.innerWidth, window.innerHeight) * density;
  return pixels <= 480 ? 480 : view === "inline" || pixels <= 960 ? 960 : 1920;
}
