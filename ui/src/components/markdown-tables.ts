import type { MarkdownIt } from "markdown-it";
import { escapeHtml } from "../../../src/shared/html-escape.js";
import { t } from "../i18n/index.ts";
import { formatUiError, UserFacingError } from "../lib/format-error.ts";
import { cancelLayout, scheduleLayout } from "../lib/layout-frame.ts";
import { anchorFromNavigationEvent } from "../lib/navigation-click.ts";
import { listen } from "../lib/reactive/listener.ts";
import { showToast } from "../lib/toast.ts";
import { isMarkdownBlockParked } from "./markdown-block-presentation.ts";
import { copyMarkdownText } from "./markdown-copy.ts";
import { createIconElement } from "./markdown-icon.ts";
import { registerSessionTitleTarget } from "./markdown-link-display.ts";
import { SESSION_TITLE_TARGET_SELECTOR } from "./session-progress-hovercard-target.ts";

const tableShellSelector = ".chat-text .markdown-table[data-table-interactions]";
const tableViewportSelector = ".markdown-table__viewport";
const enhancedTableShells = new WeakSet<HTMLElement>();
const tableCopyStatuses = new WeakMap<HTMLElement, HTMLElement>();
const tableOwnerStates = new WeakMap<HTMLElement, TableOwnerState>();
// The DOM survives enhancer replacement and may have nested enhancement owners.
const tableBounds = new WeakMap<HTMLElement, TableBounds>();

type TableOwnerState = {
  release: () => void;
  closeDialog?: () => void;
};

type TableBounds = { viewport?: number; table?: number; offset: number };

function tableInteractionsEnabled(env: unknown): boolean {
  return (
    typeof env === "object" &&
    env !== null &&
    "tableInteractions" in env &&
    env.tableInteractions === "enabled"
  );
}

export function installMarkdownTables(markdownParser: MarkdownIt): void {
  const defaultTableOpen = markdownParser.renderer.rules.table_open;
  const defaultTableClose = markdownParser.renderer.rules.table_close;
  markdownParser.renderer.rules.table_open = (tokens, index, options, env, renderer) => {
    if (!tableInteractionsEnabled(env)) {
      return defaultTableOpen?.(tokens, index, options, env, renderer) ?? "<table>\n";
    }
    return '<div class="markdown-table" data-table-interactions><div class="markdown-table__viewport"><table>';
  };
  markdownParser.renderer.rules.table_close = (tokens, index, options, env, renderer) => {
    if (!tableInteractionsEnabled(env)) {
      return defaultTableClose?.(tokens, index, options, env, renderer) ?? "</table>\n";
    }
    return `</table></div><div class="markdown-table__actions"><button type="button" class="markdown-table__expand" aria-label="${escapeHtml(t("common.expandTable"))}"></button><button type="button" class="markdown-table__copy" aria-label="${escapeHtml(t("common.copyTable"))}"></button></div></div>`;
  };
}

export function markdownTableCopyText(table: HTMLTableElement): string {
  return [...table.rows]
    .map((row) => [...row.cells].map((cell) => cell.textContent?.trim() ?? "").join("\t"))
    .join("\n");
}

function measureTableOverflow(shell: HTMLElement, bounds: TableBounds): (() => void) | undefined {
  if (isMarkdownBlockParked(shell)) {
    return undefined;
  }
  if (bounds.viewport === undefined || bounds.table === undefined) {
    return undefined;
  }
  const { viewport, table, offset } = bounds;
  const overflows = table - viewport > 1;
  return () => {
    shell.classList.toggle("markdown-table--can-scroll-left", overflows && offset > 1);
    shell.classList.toggle(
      "markdown-table--can-scroll-right",
      overflows && offset + viewport < table - 1,
    );
  };
}

function enhanceTableShell(shell: HTMLElement): void {
  if (enhancedTableShells.has(shell)) {
    return;
  }
  const expand = shell.querySelector<HTMLElement>(".markdown-table__expand");
  const copy = shell.querySelector<HTMLElement>(".markdown-table__copy");
  if (!expand || !copy) {
    return;
  }
  enhancedTableShells.add(shell);
  const label = shell.ownerDocument.createElement("span");
  label.textContent = t("common.expandTable");
  expand.replaceChildren(createIconElement("maximize", shell.ownerDocument), label);
  copy.replaceChildren(createIconElement("copy", shell.ownerDocument));
  const status = shell.ownerDocument.createElement("span");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  copy.after(status);
  tableCopyStatuses.set(copy, status);
}

export function enhanceMarkdownTables(owner: HTMLElement): TableOwnerState {
  let state = tableOwnerStates.get(owner);
  if (!state) {
    const observedNodes = new Set<HTMLElement>();
    const pendingOverflow = new Map<HTMLElement, TableBounds>();
    const resizeObserver = new ResizeObserver((entries) => {
      // Earlier resize subscribers may have dirtied layout. Consume the delivered
      // boxes instead of forcing another layout for scrollWidth/clientWidth.
      for (const entry of entries) {
        const shell = entry.target.closest<HTMLElement>(tableShellSelector);
        if (!shell || isMarkdownBlockParked(shell)) {
          continue;
        }
        const viewport = entry.target.closest<HTMLElement>(tableViewportSelector)!;
        const bounds = tableBounds.get(viewport) ?? { offset: 0 };
        if (entry.target.matches(tableViewportSelector)) {
          bounds.viewport = entry.contentRect.width;
        } else {
          bounds.table = entry.borderBoxSize[0]!.inlineSize;
        }
        tableBounds.set(viewport, bounds);
        pendingOverflow.set(shell, bounds);
      }
      if (pendingOverflow.size) {
        // Overflow chrome can affect layout; publish it after resize delivery.
        scheduleLayout(pendingOverflow, () => {
          const updates = [...pendingOverflow].map(([shell, bounds]) =>
            owner.contains(shell) ? measureTableOverflow(shell, bounds) : undefined,
          );
          pendingOverflow.clear();
          return () => updates.forEach((update) => update?.());
        });
      }
    });
    const syncTables = (shells: Iterable<HTMLElement>) => {
      for (const shell of shells) {
        if (!owner.contains(shell)) {
          continue;
        }
        if (isMarkdownBlockParked(shell)) {
          for (const node of observedNodes) {
            if (shell.contains(node)) {
              observedNodes.delete(node);
              resizeObserver.unobserve(node);
            }
          }
          continue;
        }
        enhanceTableShell(shell);
        // Both boxes are observed after layout; mutation-time reads would force
        // layout again after each table's chrome is installed.
        for (const node of shell.querySelectorAll<HTMLElement>(`${tableViewportSelector}, table`)) {
          if (!observedNodes.has(node)) {
            observedNodes.add(node);
            resizeObserver.observe(node);
          }
        }
      }
    };
    const mutationObserver = new MutationObserver((records) => {
      const shells = new Set<HTMLElement>();
      const collectShells = (node: HTMLElement) => {
        if (node.matches(tableShellSelector)) {
          shells.add(node);
        }
        // Syntax highlighting inserts many leaf spans, which cannot contain tables.
        if (node.firstElementChild) {
          for (const shell of node.querySelectorAll<HTMLElement>(tableShellSelector)) {
            shells.add(shell);
          }
        }
      };
      for (const record of records) {
        const target =
          record.target instanceof Element ? record.target : record.target.parentElement;
        const shell = target?.closest<HTMLElement>(tableShellSelector);
        if (record.type === "attributes" && target instanceof HTMLElement) {
          collectShells(target);
        }
        // Icon/copy feedback belongs to the controls and cannot change the table's width.
        if (shell && (target === shell || target?.closest(tableViewportSelector))) {
          shells.add(shell);
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) {
            continue;
          }
          collectShells(node);
        }
        for (const node of record.removedNodes) {
          if (!(node instanceof HTMLElement) || owner.contains(node)) {
            continue;
          }
          const removed = [
            node,
            ...(node.firstElementChild
              ? node.querySelectorAll<HTMLElement>(`${tableViewportSelector}, table`)
              : []),
          ];
          for (const observed of removed) {
            if (observedNodes.delete(observed)) {
              resizeObserver.unobserve(observed);
            }
          }
        }
      }
      syncTables(shells);
    });
    const stopScroll = listen(
      owner,
      "scroll",
      (event) => {
        const viewport = event.target;
        if (!(viewport instanceof HTMLElement) || !viewport.matches(tableViewportSelector)) {
          return;
        }
        // Message roots and their transcript can both own table enhancements.
        const nearestOwner = event
          .composedPath()
          .find((node) => node instanceof HTMLElement && tableOwnerStates.has(node));
        if (nearestOwner !== owner) {
          return;
        }
        const shell = viewport.closest<HTMLElement>(tableShellSelector);
        const bounds = tableBounds.get(viewport);
        if (shell && bounds) {
          pendingOverflow.delete(shell);
          bounds.offset = viewport.scrollLeft;
          measureTableOverflow(shell, bounds)?.();
        }
      },
      { capture: true, passive: true },
    );
    state = {
      release: () => {
        stopScroll();
        mutationObserver.disconnect();
        resizeObserver.disconnect();
        cancelLayout(pendingOverflow);
        pendingOverflow.clear();
      },
    };
    tableOwnerStates.set(owner, state);
    syncTables(owner.querySelectorAll<HTMLElement>(tableShellSelector));
    mutationObserver.observe(owner, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-prepared-row", "data-preparing-row"],
    });
  }
  return state;
}

export function releaseMarkdownTables(owner: HTMLElement): void {
  const state = tableOwnerStates.get(owner);
  tableOwnerStates.delete(owner);
  state?.release();
  state?.closeDialog?.();
}

async function showTableDialog(
  table: HTMLTableElement,
  trigger: HTMLElement,
  owner: HTMLElement,
): Promise<void> {
  const state = tableOwnerStates.get(owner) ?? enhanceMarkdownTables(owner);
  if (state.closeDialog) {
    return;
  }
  let dialog: HTMLElementTagNameMap["openclaw-modal-dialog"] | undefined;
  const stopListeners: Array<() => void> = [];
  const close = () => {
    if (state.closeDialog === close) {
      delete state.closeDialog;
    }
    for (const stop of stopListeners.splice(0)) {
      stop();
    }
    dialog?.remove();
  };
  // Reserve through teardown before loading; reconnect cannot revive this request.
  state.closeDialog = close;
  try {
    try {
      await import("./modal-dialog.tsx");
    } catch (cause) {
      throw new UserFacingError(`${t("lazyView.errorTitle")}. ${t("lazyView.staleSubtitle")}`, {
        cause,
      });
    }
    if (state.closeDialog !== close || !owner.isConnected || !trigger.isConnected) {
      return;
    }
    dialog = document.createElement("openclaw-modal-dialog");
    dialog.className = "markdown-table-modal";
    dialog.label = t("common.expandedTable");
    dialog.setReturnFocusTarget(trigger);
    const dismissLink = (event: Event) => {
      const anchor = anchorFromNavigationEvent(event);
      if (
        !anchor ||
        (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ")
      ) {
        return;
      }
      // Listener microtasks can precede ancestor routing. Defer removal until
      // routing and the browser's default href activation have finished.
      setTimeout(() => {
        if (
          event.type === "click" ||
          event.defaultPrevented ||
          (event instanceof MouseEvent && event.button === 1 && anchor.hasAttribute("href"))
        ) {
          close();
        }
      }, 0);
    };
    stopListeners.push(listen(dialog, "modal-cancel", close));
    const content = document.createElement("div");
    content.className = "markdown-table-dialog chat-text";
    content.dir = getComputedStyle(table).direction;
    for (const event of ["click", "auxclick", "keydown"]) {
      stopListeners.push(listen(content, event, dismissLink));
    }
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "markdown-table-dialog__close";
    dismiss.setAttribute("aria-label", t("common.closeTable"));
    dismiss.autofocus = true;
    dialog.initialFocus = () => dismiss;
    stopListeners.push(listen(dismiss, "click", close));
    dismiss.append(createIconElement("x", document));
    content.append(dismiss, table.cloneNode(true));
    dialog.append(content);
    // Keep delegated file/session actions and modal teardown with their transcript.
    owner.append(dialog);
    // Cloned anchors need their own href lifetime before the source is decorated.
    for (const target of content.querySelectorAll<HTMLElement>(SESSION_TITLE_TARGET_SELECTOR)) {
      stopListeners.push(registerSessionTitleTarget(target, document.createElement("span")));
    }
  } catch (error) {
    if (state.closeDialog === close && owner.isConnected && trigger.isConnected) {
      showToast({ message: formatUiError(error), severity: "error" });
    }
  } finally {
    if (!dialog) {
      close();
    }
  }
}

export function handleMarkdownTableInteraction(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const shell = target.closest<HTMLElement>(tableShellSelector);
  if (!shell) {
    return;
  }
  enhanceTableShell(shell);
  const table = shell.querySelector<HTMLTableElement>("table");
  if (!table) {
    return;
  }
  const expand = target.closest<HTMLElement>(".markdown-table__expand");
  if (expand && event.currentTarget instanceof HTMLElement) {
    void showTableDialog(table, expand, event.currentTarget);
    return;
  }
  const copy = target.closest<HTMLElement>(".markdown-table__copy");
  if (copy) {
    const text = markdownTableCopyText(table);
    copyMarkdownText(
      copy,
      text,
      () =>
        table.isConnected &&
        shell.querySelector("table") === table &&
        markdownTableCopyText(table) === text,
      (copied) => {
        copy.replaceChildren(createIconElement(copied ? "check" : "copy", copy.ownerDocument));
        const status = tableCopyStatuses.get(copy);
        if (status) {
          status.textContent =
            copied === undefined ? "" : t(copied ? "common.copied" : "common.copyFailed");
        }
        if (copied === undefined) {
          copy.setAttribute("aria-label", t("common.copyTable"));
        } else {
          copy.setAttribute("aria-label", t(copied ? "common.copied" : "common.copyFailed"));
        }
      },
    );
  }
}
