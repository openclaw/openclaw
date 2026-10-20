import { type DefaultAppOpenOutcome, webKitHostWindow } from "../app/native-webkit-bridge.ts";
import { t } from "./reactive/i18n.ts";
import { showToast } from "./toast.ts";

// Desktop editors reachable from the browser UI via custom URL schemes; a
// window.open on these hands off to the OS without navigating the page.
export const EDITOR_IDS = ["cursor", "vscode", "windsurf", "zed"] as const;
export type EditorId = (typeof EDITOR_IDS)[number];

// Product names, not translatable copy.
export const EDITOR_LABELS: Record<EditorId, string> = {
  cursor: "Cursor",
  vscode: "VS Code",
  windsurf: "Windsurf",
  zed: "Zed",
};

// A single file can also open in the app macOS assigns to its type (for
// example Typora for Markdown). Only the Mac app can hand off a local file.
export type FileOpenTarget = EditorId | "default-app";

export function fileOpenTargets(): readonly FileOpenTarget[] {
  // Handler presence is the feature probe: older Mac apps lack it.
  return webKitHostWindow()?.webkit?.messageHandlers?.openclawFiles
    ? [...EDITOR_IDS, "default-app"]
    : EDITOR_IDS;
}

export function openEditor(editor: EditorId, absPath: string, line?: number | null) {
  const normalizedPath = absPath.replaceAll("\\", "/");
  const urlPath = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
  const encodedPath = urlPath
    .split("/")
    .map((segment, index) =>
      index === 1 && /^[a-z]:$/i.test(segment) ? segment : encodeURIComponent(segment),
    )
    .join("/");
  // Typed editor IDs plus encoded paths make this custom-scheme handoff safe.
  return window.open(`${editor}://file${encodedPath}${line ? `:${line}` : ""}`);
}

const DEFAULT_APP_REFUSAL_KEYS = {
  remote: "chat.fileOpen.defaultAppRemote",
  missing: "chat.fileOpen.defaultAppMissing",
  "unsupported-type": "chat.fileOpen.defaultAppUnsupported",
  "no-app": "chat.fileOpen.defaultAppNoApp",
} as const satisfies Record<Exclude<DefaultAppOpenOutcome, "opened">, string>;

async function openInDefaultApp(path: string) {
  const handler = webKitHostWindow()?.webkit?.messageHandlers?.openclawFiles;
  let outcome: DefaultAppOpenOutcome | "failed";
  try {
    // WebKit's reply handler is not Window.postMessage and takes no target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    outcome = handler ? await handler.postMessage({ type: "open-default-app", path }) : "failed";
  } catch {
    outcome = "failed";
  }
  if (outcome === "opened") {
    return;
  }
  // The native app refuses before launching; tell the operator why and what to use instead.
  showToast({
    message: t(
      outcome === "failed" ? "chat.fileOpen.defaultAppFailed" : DEFAULT_APP_REFUSAL_KEYS[outcome],
    ),
  });
}

export function openFile(target: FileOpenTarget, absPath: string, line?: number | null) {
  if (target === "default-app") {
    void openInDefaultApp(absPath);
    return;
  }
  openEditor(target, absPath, line);
}
