import { html, render } from "lit";
import type { MarkdownIt } from "markdown-it";
import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { anchorFromNavigationEvent } from "../lib/navigation-click.ts";
import { toolIcons } from "./icons-tools.ts";
import { icons } from "./icons.ts";
import { escapeMarkdownHtml } from "./markdown-text.ts";

const tableShellSelector = ".chat-text .markdown-table[data-table-interactions]";
const tableViewportSelector = ".markdown-table__viewport";
const enhancedTableShells = new WeakSet<HTMLElement>();
const tableOwnerStates = new WeakMap<HTMLElement, TableOwnerState>();
const tableCopyResetTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
const tableCopyAttempts = new WeakMap<HTMLElement, number>();

type TableOwnerState = {
  release: () => void;
  closeDialog?: () => void;
};

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
    return `</table></div><div class="markdown-table__actions"><button type="button" class="markdown-table__expand" aria-label="${escapeMarkdownHtml(t("common.expandTable"))}"></button><button type="button" class="markdown-table__copy" aria-label="${escapeMarkdownHtml(t("common.copyTable"))}"></button></div></div>`;
  };
}

export function markdownTableCopyText(table: HTMLTableElement): string {
  return [...table.rows]
    .map((row) => [...row.cells].map((cell) => cell.textContent?.trim() ?? "").join("\t"))
    .join("\n");
}

function syncTableOverflow(shell: HTMLElement): void {
  const viewport = shell.querySelector<HTMLElement>(tableViewportSelector);
  if (!viewport) {
    return;
  }
  const { scrollWidth, clientWidth, scrollLeft } = viewport;
  const overflows = scrollWidth - clientWidth > 1;
  shell.classList.toggle("markdown-table--can-scroll-left", overflows && scrollLeft > 1);
  shell.classList.toggle(
    "markdown-table--can-scroll-right",
    overflows && scrollLeft + clientWidth < scrollWidth - 1,
  );
}

function enhanceTableShell(shell: HTMLElement): void {
  if (enhancedTableShells.has(shell)) {
    return;
  }
  const viewport = shell.querySelector<HTMLElement>(tableViewportSelector);
  const expand = shell.querySelector<HTMLElement>(".markdown-table__expand");
  const copy = shell.querySelector<HTMLElement>(".markdown-table__copy");
  if (!viewport || !expand || !copy) {
    return;
  }
  enhancedTableShells.add(shell);
  render(toolIcons.maximize, expand);
  render(icons.copy, copy);
  viewport.addEventListener("scroll", () => syncTableOverflow(shell), { passive: true });
}

export function enhanceMarkdownTables(owner: HTMLElement): TableOwnerState {
  let state = tableOwnerStates.get(owner);
  if (!state) {
    const observedNodes = new Set<HTMLElement>();
    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver((entries) => {
            const shells = new Set(
              entries.map((entry) => entry.target.closest<HTMLElement>(tableShellSelector)),
            );
            for (const shell of shells) {
              if (shell) {
                syncTableOverflow(shell);
              }
            }
          })
        : null;
    const syncTables = (shells: Iterable<HTMLElement>) => {
      for (const shell of shells) {
        if (!owner.contains(shell)) {
          continue;
        }
        enhanceTableShell(shell);
        syncTableOverflow(shell);
        for (const node of shell.querySelectorAll<HTMLElement>(`${tableViewportSelector}, table`)) {
          if (!observedNodes.has(node)) {
            observedNodes.add(node);
            resizeObserver?.observe(node);
          }
        }
      }
    };
    const mutationObserver = new MutationObserver((records) => {
      const shells = new Set<HTMLElement>();
      for (const record of records) {
        const target =
          record.target instanceof Element ? record.target : record.target.parentElement;
        const shell = target?.closest<HTMLElement>(tableShellSelector);
        // Icon/copy feedback belongs to the controls and cannot change the table's width.
        if (shell && (target === shell || target?.closest(tableViewportSelector))) {
          shells.add(shell);
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) {
            continue;
          }
          if (node.matches(tableShellSelector)) {
            shells.add(node);
          }
          for (const added of node.querySelectorAll<HTMLElement>(tableShellSelector)) {
            shells.add(added);
          }
        }
        for (const node of record.removedNodes) {
          if (!(node instanceof HTMLElement) || owner.contains(node)) {
            continue;
          }
          const removed = [
            node,
            ...node.querySelectorAll<HTMLElement>(`${tableViewportSelector}, table`),
          ];
          for (const observed of removed) {
            if (observedNodes.delete(observed)) {
              resizeObserver?.unobserve(observed);
            }
          }
        }
      }
      syncTables(shells);
    });
    state = {
      release: () => {
        mutationObserver.disconnect();
        resizeObserver?.disconnect();
      },
    };
    tableOwnerStates.set(owner, state);
    syncTables(owner.querySelectorAll<HTMLElement>(tableShellSelector));
    mutationObserver.observe(owner, { childList: true, subtree: true, characterData: true });
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
  const close = () => {
    if (state.closeDialog === close) {
      delete state.closeDialog;
    }
    dialog?.remove();
  };
  // Reserve through teardown before loading; reconnect cannot revive this request.
  state.closeDialog = close;
  try {
    await import("./modal-dialog.ts");
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
    dialog.addEventListener("modal-cancel", close);
    render(
      html`
        <div
          class="markdown-table-dialog chat-text"
          @click=${dismissLink}
          @auxclick=${dismissLink}
          @keydown=${dismissLink}
        >
          <button
            type="button"
            class="markdown-table-dialog__close"
            aria-label=${t("common.closeTable")}
            autofocus
            @click=${close}
          >
            ${icons.x}
          </button>
          ${table.cloneNode(true)}
        </div>
      `,
      dialog,
    );
    // Keep delegated file/session actions and modal teardown with their transcript.
    owner.append(dialog);
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
    const attempt = (tableCopyAttempts.get(copy) ?? 0) + 1;
    tableCopyAttempts.set(copy, attempt);
    // A streaming table retains its controls, but only the current payload
    // may start fallback copying or update their feedback.
    const isCurrent = () =>
      copy.isConnected &&
      table.isConnected &&
      tableCopyAttempts.get(copy) === attempt &&
      shell.querySelector("table") === table &&
      markdownTableCopyText(table) === text;
    void copyToClipboard(text, isCurrent).then((copied) => {
      if (!isCurrent()) {
        return;
      }
      copy.setAttribute("aria-label", t(copied ? "common.copied" : "common.copyFailed"));
      render(copied ? icons.check : icons.copy, copy);
      clearTimeout(tableCopyResetTimers.get(copy));
      const resetTimer = setTimeout(
        () => {
          render(icons.copy, copy);
          copy.setAttribute("aria-label", t("common.copyTable"));
          tableCopyResetTimers.delete(copy);
        },
        copied ? 1500 : 2000,
      );
      tableCopyResetTimers.set(copy, resetTimer);
    });
  }
}
