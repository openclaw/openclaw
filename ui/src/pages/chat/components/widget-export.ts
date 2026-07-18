const WIDGET_SNAPSHOT_REQUEST_TYPE = "openclaw:widget-snapshot-request";
const WIDGET_SNAPSHOT_REPLY_TYPE = "openclaw:widget-snapshot";
const WIDGET_SNAPSHOT_TIMEOUT_MS = 5_000;
const WIDGET_SNAPSHOT_MAX_DATA_URL_CHARS = 32 * 1024 * 1024;

export type WidgetExportAction = "copy" | "download";
export type WidgetExportResult = "png" | "html" | "rerender-required";

type WidgetSnapshotReply = {
  type?: unknown;
  id?: unknown;
  dataUrl?: unknown;
  error?: unknown;
};

type WidgetExportRuntime = {
  timeoutMs?: number;
  requestSnapshot?: typeof requestWidgetSnapshot;
  copyImage?: typeof copyWidgetImage;
  download?: typeof downloadHref;
  fetch?: typeof globalThis.fetch;
};

class WidgetSnapshotUnavailableError extends Error {}

function createSnapshotRequestId(): string {
  const values = crypto.getRandomValues(new Uint32Array(4));
  return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
}

export function validateWidgetSnapshotDataUrl(dataUrl: unknown): dataUrl is string {
  return (
    typeof dataUrl === "string" &&
    dataUrl.startsWith("data:image/png;base64,") &&
    dataUrl.length <= WIDGET_SNAPSHOT_MAX_DATA_URL_CHARS
  );
}

export function sanitizeWidgetExportTitle(title: string | undefined): string {
  const sanitized = (title ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[. -]+|[. -]+$/g, "")
    .slice(0, 120)
    .replace(/[. -]+$/g, "");
  return sanitized || "widget";
}

export function requestWidgetSnapshot(
  frame: HTMLIFrameElement,
  options: { id?: string; timeoutMs?: number } = {},
): Promise<string> {
  const target = frame.contentWindow;
  if (!target) {
    return Promise.reject(new Error("widget frame is unavailable"));
  }
  const id = options.id ?? createSnapshotRequestId();
  const timeoutMs = options.timeoutMs ?? WIDGET_SNAPSHOT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const cleanup = () => {
      window.removeEventListener("message", handleMessage);
      if (timeout !== undefined) {
        globalThis.clearTimeout(timeout);
      }
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
        return;
      }
      if (!validateWidgetSnapshotDataUrl(payload.dataUrl)) {
        fail(new Error("widget returned an invalid snapshot"));
        return;
      }
      cleanup();
      resolve(payload.dataUrl);
    };

    window.addEventListener("message", handleMessage);
    timeout = globalThis.setTimeout(
      () => fail(new WidgetSnapshotUnavailableError("widget snapshot request timed out")),
      timeoutMs,
    );
    try {
      target.postMessage({ type: WIDGET_SNAPSHOT_REQUEST_TYPE, id }, "*");
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function copyWidgetImage(dataUrl: Promise<string>): Promise<void> {
  const blob = dataUrl.then(async (value) => {
    const response = await fetch(value);
    return response.blob();
  });
  // If clipboard construction itself fails, it will not adopt the promised
  // representation, so keep a rejection from surfacing as unhandled.
  void blob.catch(() => {});
  // Start the permission-gated write while the menu selection still carries
  // transient user activation; ClipboardItem resolves the PNG afterward.
  return navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

function downloadHref(href: string, filename: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
}

async function downloadLegacyWidgetDocument(
  frame: HTMLIFrameElement,
  filename: string,
  runtime: Pick<WidgetExportRuntime, "fetch" | "download">,
): Promise<void> {
  const src = frame.getAttribute("src");
  if (!src) {
    throw new Error("widget document URL is unavailable");
  }
  const url = new URL(src, window.location.href);
  if (url.origin !== window.location.origin) {
    throw new Error("widget document URL is not same-origin");
  }
  const fetchDocument = runtime.fetch ?? globalThis.fetch;
  const response = await fetchDocument(url.href);
  if (!response.ok) {
    throw new Error(`widget document download failed (${response.status})`);
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    (runtime.download ?? downloadHref)(objectUrl, `${filename}.html`);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function exportWidget(
  action: WidgetExportAction,
  frame: HTMLIFrameElement,
  title: string | undefined,
  runtime: WidgetExportRuntime = {},
): Promise<WidgetExportResult> {
  const filename = sanitizeWidgetExportTitle(title);
  const snapshot = (runtime.requestSnapshot ?? requestWidgetSnapshot)(
    frame,
    runtime.timeoutMs === undefined ? {} : { timeoutMs: runtime.timeoutMs },
  );

  if (action === "copy") {
    try {
      await (runtime.copyImage ?? copyWidgetImage)(snapshot);
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
    (runtime.download ?? downloadHref)(dataUrl, `${filename}.png`);
    return "png";
  } catch (error) {
    if (!(error instanceof WidgetSnapshotUnavailableError)) {
      throw error;
    }
    await downloadLegacyWidgetDocument(frame, filename, runtime);
    return "html";
  }
}
