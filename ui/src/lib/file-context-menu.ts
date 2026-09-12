import { t } from "../i18n/index.ts";
import {
  availableFileActions,
  isSafeFileReference,
  type FileAction,
  type FileReference,
} from "./file-reference.ts";

const FILE_ACTION_LABEL_KEYS: Record<FileAction, string> = {
  preview: "chat.workspaceFiles.preview",
  copyFullPath: "fileActions.copyFullPath",
  copyRelativePath: "fileActions.copyRelativePath",
  copyFilename: "fileActions.copyFilename",
  copyContents: "chat.detailPanel.copyContents",
  download: "chat.toolCards.downloadFile",
  openInEditor: "chat.sessionDiff.openInEditor",
  revealInFileManager: "fileActions.revealInFileManager",
  openWorkspaceRoot: "fileActions.openWorkspaceRoot",
  refresh: "common.refresh",
};

let activeClose: (() => void) | null = null;

export interface FileActionMenuOptions {
  event: Event;
  /** Focusable control for delegated events and focus restoration. */
  trigger?: HTMLElement;
  actions: readonly FileAction[];
  onAction: (action: FileAction) => void | Promise<void>;
  /** A modal owner keeps the popover inside its native dialog's active subtree. */
  container?: HTMLElement;
}

export interface FileContextMenuOptions extends Omit<FileActionMenuOptions, "actions"> {
  reference: FileReference;
  localGateway?: boolean;
  hasContents?: boolean;
  actions?: readonly FileAction[];
}

export function openFileContextMenu(options: FileContextMenuOptions): (() => void) | null {
  if (!isSafeFileReference(options.reference)) {
    return null;
  }
  return openFileActionMenu({
    ...options,
    actions: options.actions ?? availableFileActions(options.reference, options),
  });
}

/** Own one keyboard-accessible menu lifecycle for references and loaded previews. */
export function openFileActionMenu(options: FileActionMenuOptions): (() => void) | null {
  if (options.actions.length === 0) {
    return null;
  }
  const { event } = options;
  event.preventDefault();
  event.stopPropagation();
  activeClose?.();
  const trigger =
    options.trigger ?? (event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
  const menu = document.createElement("div");
  menu.className = "chat-workspace-file-menu";
  menu.role = "menu";
  menu.ariaLabel = t("chat.workspaceFiles.actions");
  menu.popover = "manual";
  // The same styles must work in the document and the preview's shadow root.
  const style = document.createElement("style");
  style.textContent = `
    .chat-workspace-file-menu {
      position: fixed; inset: auto; margin: 0; box-sizing: border-box;
      max-width: calc(100vw - 16px); max-height: calc(100dvh - 16px); overflow: auto;
      padding: 4px; border: 1px solid var(--border-strong, currentColor);
      border-radius: var(--radius-md, 6px); background: var(--bg, Canvas); color: var(--text, CanvasText);
    }
    .chat-workspace-file-menu > button {
      display: block; width: 100%; text-align: start; padding: 6px 12px;
      border: 0; border-radius: 3px; background: transparent; color: inherit; font: inherit;
    }
    .chat-workspace-file-menu > button:is(:hover, :focus-visible) {
      background: var(--bg-hover, ButtonFace); outline: 1px solid currentColor;
    }
  `;
  menu.append(style);
  const error = document.createElement("div");
  error.role = "alert";
  error.hidden = true;
  menu.append(error);
  let closed = false;
  const close = () => {
    // A completed action from an obsolete menu must not restore its old focus.
    if (closed) {
      return;
    }
    closed = true;
    menu.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKeydown, true);
    if (activeClose === close) {
      activeClose = null;
    }
    if (trigger?.isConnected) {
      trigger.focus({ preventScroll: true });
    }
  };
  const onOutside = (pointerEvent: PointerEvent) => {
    if (!pointerEvent.composedPath().includes(menu)) {
      close();
    }
  };
  const onKeydown = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key === "Escape" || keyEvent.key === "Tab") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(keyEvent.key)) {
      return;
    }
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const root = menu.getRootNode();
    const focused =
      root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null;
    const current = items.findIndex((item) => item === focused);
    const index =
      keyEvent.key === "Home"
        ? 0
        : keyEvent.key === "End"
          ? items.length - 1
          : (current + (keyEvent.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[index]?.focus();
  };
  for (const action of options.actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "menuitem";
    button.textContent = t(FILE_ACTION_LABEL_KEYS[action]);
    const runAction = async () => {
      button.disabled = true;
      error.hidden = true;
      try {
        await options.onAction(action);
        close();
      } catch {
        if (!closed) {
          error.textContent = t("fileActions.failed");
          error.hidden = false;
          button.disabled = false;
          button.focus();
        }
      }
    };
    button.addEventListener("click", (clickEvent) => {
      // Keep menu activation from also triggering a surrounding openable card.
      clickEvent.stopPropagation();
      void runAction();
    });
    menu.append(button);
  }
  (options.container ?? trigger?.parentElement ?? document.body).append(menu);
  menu.showPopover();
  const rect = trigger?.getBoundingClientRect();
  const mouse = event instanceof MouseEvent ? event : null;
  const x = mouse && mouse.clientX > 0 ? mouse.clientX : (rect?.left ?? 8);
  const y = mouse && mouse.clientY > 0 ? mouse.clientY : (rect?.bottom ?? 8);
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKeydown, true);
  activeClose = close;
  menu.querySelector<HTMLButtonElement>("button")?.focus();
  return close;
}
