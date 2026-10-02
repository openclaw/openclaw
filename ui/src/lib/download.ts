import { t } from "../i18n/index.ts";
import { showToast } from "./toast.ts";

export function downloadTextFile(filename: string, content: string, type = "text/plain"): void {
  downloadBlobFile(filename, new Blob([content], { type }));
}

export function downloadBlobFile(filename: string, content: Blob): void {
  if (isStandaloneDisplay()) {
    void saveStandaloneFile(filename, content);
    return;
  }
  clickBlobDownload(filename, content);
}

function clickBlobDownload(filename: string, content: Blob): void {
  const url = URL.createObjectURL(content);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Safari reads the blob after the click returns, so keep the URL alive for a while.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Home screen web apps (iOS "Add to Home Screen") have no browser chrome, so a
 * file navigation replaces the app with no way back and no way to save it.
 */
export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  // iOS Safari reports home screen apps through the non-standard navigator.standalone.
  if (Reflect.get(navigator, "standalone") === true) {
    return true;
  }
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(display-mode: standalone)").matches
    : false;
}

function shareableFile(filename: string, content: Blob): File | null {
  if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") {
    return null;
  }
  const file =
    content instanceof File && content.name === filename
      ? content
      : new File([content], filename, { type: content.type });
  try {
    return navigator.canShare({ files: [file] }) ? file : null;
  } catch {
    return null;
  }
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error || error instanceof DOMException ? error.name : undefined;
}

/**
 * Saves a file from a standalone app through the system share sheet (Save to
 * Files, AirDrop, ...). Falls back to a blob download when files cannot be shared.
 */
async function saveStandaloneFile(filename: string, content: Blob): Promise<void> {
  const file = shareableFile(filename, content);
  if (!file) {
    clickBlobDownload(filename, content);
    return;
  }
  const share = () => navigator.share({ files: [file] });
  const reportFailure = (error: unknown) => {
    // AbortError is the user closing the share sheet.
    if (errorName(error) !== "AbortError") {
      showToast({ message: t("common.downloadFailed", { filename }) });
    }
  };
  try {
    await share();
  } catch (error) {
    if (errorName(error) !== "NotAllowedError") {
      reportFailure(error);
      return;
    }
    // The click activation expired while the bytes were loading. A second tap
    // carries a fresh activation.
    showToast({
      message: t("common.downloadReady", { filename }),
      actionLabel: t("common.save"),
      onAction: () => void share().catch(reportFailure),
      durationMs: 15_000,
    });
  }
}

function fileNameFromUrl(url: URL): string {
  const segment = url.pathname.split("/").findLast(Boolean);
  try {
    return segment ? decodeURIComponent(segment) : "download";
  } catch {
    return segment || "download";
  }
}

/** Fetches a same-origin, blob or data URL and saves it without navigating the app. */
export async function saveStandaloneUrl(href: string, filename?: string): Promise<void> {
  const url = new URL(href, window.location.href);
  const name = filename?.trim() || fileNameFromUrl(url);
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) {
      throw new Error(`download failed: ${response.status}`);
    }
    await saveStandaloneFile(name, await response.blob());
  } catch {
    showToast({ message: t("common.downloadFailed", { filename: name }) });
  }
}
