import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { beginClipboardCopy } from "../../../lib/clipboard.ts";

const WIDGET_SNAPSHOT_REQUEST_TYPE = "openclaw:widget-snapshot-request";
const WIDGET_SNAPSHOT_REPLY_TYPE = "openclaw:widget-snapshot";
const WIDGET_SNAPSHOT_TIMEOUT_MS = 5_000;
const WIDGET_SNAPSHOT_MAX_DATA_URL_CHARS = 32 * 1024 * 1024;

type WidgetSnapshotReply = { type?: unknown; id?: unknown; dataUrl?: unknown; error?: unknown };
class WidgetSnapshotUnavailableError extends Error {}

function requestWidgetSnapshot(frame: HTMLIFrameElement): Promise<string> {
  const target = frame.contentWindow;
  if (!target) {
    return Promise.reject(new Error("widget frame is unavailable"));
  }
  const id = Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
    value.toString(16).padStart(8, "0"),
  ).join("");

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("message", handleMessage);
      globalThis.clearTimeout(timeout);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== target) {
        return;
      }
      const payload = event.data as WidgetSnapshotReply | null;
      if (!payload || payload.type !== WIDGET_SNAPSHOT_REPLY_TYPE || payload.id !== id) {
        return;
      }
      if (typeof payload.error === "string") {
        fail(new Error(payload.error));
      } else if (
        typeof payload.dataUrl !== "string" ||
        !payload.dataUrl.startsWith("data:image/png;base64,") ||
        payload.dataUrl.length > WIDGET_SNAPSHOT_MAX_DATA_URL_CHARS
      ) {
        fail(new Error("widget returned an invalid snapshot"));
      } else {
        cleanup();
        resolve(payload.dataUrl);
      }
    };

    window.addEventListener("message", handleMessage);
    const timeout = globalThis.setTimeout(
      () => fail(new WidgetSnapshotUnavailableError("widget snapshot request timed out")),
      WIDGET_SNAPSHOT_TIMEOUT_MS,
    );
    try {
      target.postMessage({ type: WIDGET_SNAPSHOT_REQUEST_TYPE, id }, "*");
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function downloadHref(href: string, filename: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
}

export async function exportWidget(
  action: "copy" | "download",
  frame: HTMLIFrameElement,
  title: string | undefined,
  options: { documentHtml?: string } = {},
): Promise<"png" | "html" | "rerender-required"> {
  const rawStem = Array.from((title ?? "").trim(), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f || '<>:"/\\|?*'.includes(character)
      ? "-"
      : character;
  })
    .join("")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[. -]+|[. -]+$/g, "");
  const filename = truncateUtf16Safe(rawStem, 120).replace(/[. -]+$/g, "") || "widget";
  const snapshot = requestWidgetSnapshot(frame);

  if (action === "copy") {
    beginClipboardCopy();
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("image clipboard is unavailable");
      }
      const blob = snapshot.then(async (value) => (await globalThis.fetch(value)).blob());
      void blob.catch(() => {});
      // ClipboardItem keeps the click's transient activation while its PNG promise resolves.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return "png";
    } catch (error) {
      const snapshotError = await snapshot.then(
        () => null,
        (reason: unknown) => reason,
      );
      if (snapshotError instanceof WidgetSnapshotUnavailableError) {
        return "rerender-required";
      }
      throw snapshotError ?? error;
    }
  }

  try {
    const dataUrl = await snapshot;
    downloadHref(dataUrl, `${filename}.png`);
    return "png";
  } catch (error) {
    if (!(error instanceof WidgetSnapshotUnavailableError)) {
      throw error;
    }
    let blob: Blob;
    if (options.documentHtml !== undefined) {
      blob = new Blob([options.documentHtml], { type: "text/html" });
    } else {
      const src = frame.getAttribute("src");
      if (!src) {
        throw new Error("widget document URL is unavailable", { cause: error });
      }
      const url = new URL(src, window.location.href);
      if (url.origin !== window.location.origin) {
        throw new Error("widget document URL is not same-origin", { cause: error });
      }
      const response = await globalThis.fetch(url.href);
      if (!response.ok) {
        throw new Error(`widget document download failed (${response.status})`, { cause: error });
      }
      blob = await response.blob();
    }
    const objectUrl = URL.createObjectURL(blob);
    try {
      downloadHref(objectUrl, `${filename}.html`);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    return "html";
  }
}
