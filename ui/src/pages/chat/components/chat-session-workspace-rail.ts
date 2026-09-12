import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { renderCopyButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import { renderPanelLoadingSkeleton } from "../../../components/panel-loading-skeleton.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { openFileContextMenu } from "../../../lib/file-context-menu.ts";
import type { FileAction, FileReference } from "../../../lib/file-reference.ts";
import { formatByteSize } from "../../../lib/format.ts";
import {
  formatKeyboardShortcutCombo,
  isApplePlatform,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../../../lib/keyboard-shortcut-catalog.ts";
import type {
  SessionWorkspaceFilter,
  SessionWorkspaceProps,
} from "./chat-session-workspace-types.ts";

const SESSION_KIND_LABELS = {
  modified: "chat.workspaceFiles.changed",
  read: "chat.workspaceFiles.read",
  mixed: "chat.workspaceFiles.session",
} as const;

function formatWorkspaceFileSize(size: number | undefined): string {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    return "";
  }
  return formatByteSize(size, {
    style: "legacy-binary",
    maxUnit: "mega",
    separator: " ",
    fractionDigits: (value, unit) => (unit === "byte" ? null : Math.round(value * 10) % 10 ? 1 : 0),
  });
}

function renderRailHeaderAction({
  icon,
  label,
  onClick,
  className = "",
}: {
  icon: TemplateResult;
  label: string;
  onClick?: () => void;
  className?: string;
}) {
  return onClick
    ? html`
        <openclaw-tooltip .content=${label}>
          <button
            type="button"
            class="rail-header__action chat-workspace-rail__terminal ${className}"
            aria-label=${label}
            @click=${onClick}
          >
            ${icon}
          </button>
        </openclaw-tooltip>
      `
    : nothing;
}

function handleFileMenuKeydown(event: KeyboardEvent, onContextMenu?: (event: Event) => void) {
  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
    onContextMenu?.(event);
  }
}

function renderRailRow({
  icon,
  name,
  meta,
  tooltip = name,
  badge = nothing,
  actions = nothing,
  onOpen,
  onContextMenu,
  active = false,
  directory = false,
}: {
  icon: TemplateResult;
  name: string;
  meta?: string;
  tooltip?: string;
  badge?: TemplateResult | typeof nothing;
  actions?: TemplateResult | typeof nothing;
  onOpen: () => void;
  onContextMenu?: (event: Event) => void;
  active?: boolean;
  directory?: boolean;
}) {
  return html`
    <div
      class="chat-workspace-rail__file ${directory ? "chat-workspace-rail__file--directory" : ""}
      ${active ? "chat-workspace-rail__file--active" : ""}"
      role="listitem"
    >
      <button
        class="chat-workspace-rail__file-open"
        type="button"
        @click=${onOpen}
        @contextmenu=${onContextMenu}
        @keydown=${(event: KeyboardEvent) => handleFileMenuKeydown(event, onContextMenu)}
      >
        <span class="chat-workspace-rail__file-icon">${icon}</span>
        <span class="chat-workspace-rail__file-main">
          <openclaw-tooltip .content=${tooltip}>
            <span class="chat-workspace-rail__file-name">${name}</span>
          </openclaw-tooltip>
          ${meta ? html`<span class="chat-workspace-rail__file-meta">${meta}</span>` : nothing}
        </span>
      </button>
      ${badge} ${actions}
    </div>
  `;
}

export function renderSessionWorkspaceRail(
  sessionWorkspace: SessionWorkspaceProps | undefined,
  options: { embedded?: boolean } = {},
): TemplateResult | typeof nothing {
  // Standalone collapsed rails render nothing; the panel menu or workspace shortcut reopens them.
  if (!sessionWorkspace || (sessionWorkspace.collapsed && !options.embedded)) {
    return nothing;
  }
  // Narrow panes always present the rail as a bottom strip; a side column
  // would crush the thread below its readable minimum.
  const dock = sessionWorkspace.narrowLayout ? "bottom" : sessionWorkspace.dock;
  const files = sessionWorkspace.list?.files ?? [];
  const artifacts = sessionWorkspace.list?.artifacts ?? [];
  const browser = sessionWorkspace.list?.browser;
  const entries = browser?.entries ?? [];
  const search = sessionWorkspace.browserSearch.toLowerCase();
  const matches = (...values: (string | undefined)[]) =>
    values.some((value) => value?.toLowerCase().includes(search));
  const modifiedFiles = files.filter((file) => file.kind === "modified");
  const readFiles = files.filter((file) => file.kind === "read");
  const matchingFiles = (rows: typeof files) =>
    rows.filter((file) => matches(file.path, file.name));
  const changed = matchingFiles(modifiedFiles);
  const read = matchingFiles(readFiles);
  const matchingArtifacts = artifacts.filter((artifact) =>
    matches(artifact.title, artifact.id, artifact.mimeType),
  );
  const hasItems = files.length > 0 || artifacts.length > 0 || entries.length > 0;
  const filters = [
    {
      filter: "all",
      label: t("chat.workspaceFiles.filterAll"),
      count: files.length + artifacts.length,
    },
    {
      filter: "changed",
      label: t("chat.workspaceFiles.changedCount", { count: String(modifiedFiles.length) }),
      count: modifiedFiles.length,
    },
    {
      filter: "read",
      label: t("chat.workspaceFiles.readCount", { count: String(readFiles.length) }),
      count: readFiles.length,
    },
    {
      filter: "artifacts",
      label: t("chat.workspaceFiles.artifactCount", { count: String(artifacts.length) }),
      count: artifacts.length,
    },
  ] satisfies { filter: SessionWorkspaceFilter; label: string; count: number }[];
  // A chip whose rows vanished on refresh falls back to All so the rail never
  // ends up empty with its reset control hidden.
  const activeFilter = filters.some(
    ({ filter, count }) => filter === sessionWorkspace.filter && count > 0,
  )
    ? sessionWorkspace.filter
    : "all";
  const createFileMenu = (reference: FileReference, onOpen: () => void) => (event: Event) => {
    const actions: readonly FileAction[] =
      reference.origin === "artifact"
        ? ["preview", "copyFilename", "refresh"]
        : ["preview", "copyRelativePath", "copyFilename", "refresh"];
    openFileContextMenu({
      event,
      reference,
      actions,
      onAction: async (action) => {
        if (action === "preview") {
          onOpen();
        } else if (action === "copyRelativePath" && reference.relativePath !== undefined) {
          await navigator.clipboard.writeText(reference.relativePath);
        } else if (action === "copyFilename") {
          await navigator.clipboard.writeText(reference.name);
        } else if (action === "refresh") {
          sessionWorkspace.onRefresh();
        }
      },
    });
  };
  const renderActions = (
    onOpen: () => void,
    path?: string,
    onContextMenu?: (event: Event) => void,
  ) => html`
    <span
      class="chat-workspace-rail__row-actions"
      role="group"
      aria-label=${t("chat.workspaceFiles.actions")}
    >
      <openclaw-tooltip .content=${t("chat.workspaceFiles.preview")}>
        <button
          class="chat-workspace-rail__row-action"
          type="button"
          aria-label=${t("chat.workspaceFiles.preview")}
          @click=${(event: Event) => {
            event.stopPropagation();
            onOpen();
          }}
          @contextmenu=${onContextMenu}
          @keydown=${(event: KeyboardEvent) => handleFileMenuKeydown(event, onContextMenu)}
        >
          ${icons.eye}
        </button>
      </openclaw-tooltip>
      ${
        path === undefined
          ? nothing
          : html` <span @click=${(event: Event) => event.stopPropagation()}>
              ${renderCopyButton(path, t("chat.workspaceFiles.copyPath"))}
            </span>`
      }
    </span>
  `;
  const renderFileRows = (rows: typeof files) =>
    rows.length === 0
      ? nothing
      : html`
          <div class="chat-workspace-rail__list" role="list">
            ${rows.map((file) => {
              const onOpen = () => sessionWorkspace.onOpenFile(file.path, "session");
              const onContextMenu = createFileMenu(
                {
                  origin: "session",
                  sessionKey: sessionWorkspace.sessionKey,
                  relativePath: file.path,
                  name: file.name || file.path.split(/[\\/]/).pop() || file.path,
                },
                onOpen,
              );
              return renderRailRow({
                icon: icons.fileText,
                name: file.path || file.name,
                meta: formatWorkspaceFileSize(file.size),
                onOpen,
                active: `file:${file.path}` === sessionWorkspace.activeId,
                badge: file.missing
                  ? html`<span class="chat-workspace-rail__file-badge"
                      >${t("chat.workspaceFiles.missing")}</span
                    >`
                  : nothing,
                onContextMenu,
                actions: renderActions(onOpen, file.path, onContextMenu),
              });
            })}
          </div>
        `;
  const parentPath = !browser?.search ? browser?.parentPath : null;
  const renderBrowserRows = () => html`
    ${browser?.search ? html`<div class="chat-workspace-rail__browser-caption">${t("chat.workspaceFiles.searchResults")}</div>` : nothing}
    <div class="chat-workspace-rail__list chat-workspace-rail__list--browser" role="list">
      ${
        parentPath != null
          ? renderRailRow({
              icon: icons.folder,
              name: "..",
              directory: true,
              meta: t("chat.workspaceFiles.parentFolder"),
              onOpen: () => sessionWorkspace.onBrowsePath(parentPath),
            })
          : nothing
      }
      ${
        entries.length === 0
          ? html`<div class="chat-workspace-rail__state">
              ${t(browser?.search ? "chat.workspaceFiles.noSearchResults" : "chat.workspaceFiles.noBrowserFiles")}
            </div>`
          : nothing
      }
      ${entries.map((entry) => {
        const directory = entry.kind === "directory";
        const onOpen = () =>
          directory
            ? sessionWorkspace.onBrowsePath(entry.path)
            : sessionWorkspace.onOpenFile(entry.path, "workspace");
        const onContextMenu = directory
          ? undefined
          : createFileMenu(
              {
                origin: "workspace",
                sessionKey: sessionWorkspace.sessionKey,
                relativePath: entry.path,
                name: entry.name || entry.path.split(/[\\/]/).pop() || entry.path,
              },
              onOpen,
            );
        const kind = entry.sessionKind;
        return renderRailRow({
          icon: directory ? icons.folder : icons.fileText,
          name: entry.name,
          tooltip: entry.path || entry.name,
          meta: directory
            ? entry.path || t("chat.workspaceFiles.root")
            : [entry.path, formatWorkspaceFileSize(entry.size)].filter(Boolean).join(" / "),
          onOpen,
          directory,
          active: `file:${entry.path}` === sessionWorkspace.activeId,
          badge: kind
            ? html`<span
                class="chat-workspace-rail__file-badge chat-workspace-rail__file-badge--kind"
                >${t(SESSION_KIND_LABELS[kind])}</span
              >`
            : nothing,
          onContextMenu,
          actions: directory ? nothing : renderActions(onOpen, entry.path, onContextMenu),
        });
      })}
    </div>
    ${browser?.truncated ? html`<div class="chat-workspace-rail__state">${t("chat.workspaceFiles.truncated")}</div>` : nothing}
  `;
  const renderArtifactRows = () =>
    matchingArtifacts.length === 0
      ? nothing
      : html`
          <div class="chat-workspace-rail__list" role="list">
            ${matchingArtifacts.map((artifact) => {
              const onOpen = () => sessionWorkspace.onOpenArtifact(artifact.id);
              const onContextMenu = createFileMenu(
                {
                  origin: "artifact",
                  artifactId: artifact.id,
                  name: artifact.title,
                },
                onOpen,
              );
              return renderRailRow({
                icon: artifact.mimeType?.startsWith("image/") ? icons.image : icons.paperclip,
                name: artifact.title,
                meta: [artifact.mimeType, formatWorkspaceFileSize(artifact.sizeBytes)]
                  .filter(Boolean)
                  .join(" / "),
                onOpen,
                active: `artifact:${artifact.id}` === sessionWorkspace.activeId,
                onContextMenu,
                actions: renderActions(onOpen, undefined, onContextMenu),
              });
            })}
          </div>
        `;
  // Search and chip filters force groups open. Keying the disclosures on that
  // mode remounts them when it flips, so a group the user closed reopens, while
  // ordinary re-renders keep native toggles intact.
  const forcedOpen = Boolean(search) || activeFilter !== "all";
  const renderGroup = (
    filter: SessionWorkspaceFilter | null,
    title: string,
    count: number,
    defaultOpen: boolean,
    content: TemplateResult | typeof nothing,
  ) => {
    if (content === nothing || (activeFilter !== "all" && activeFilter !== filter)) {
      return nothing;
    }
    return keyed(
      forcedOpen,
      html`<details class="chat-workspace-rail__group" ?open=${defaultOpen || forcedOpen}>
        <summary class="chat-workspace-rail__group-summary">
          <span class="chat-workspace-rail__group-chevron" aria-hidden="true"
            >${icons.chevronRight}</span
          >
          ${title}<span class="chat-workspace-rail__group-count">${count}</span>
        </summary>
        ${content}
      </details>`,
    );
  };
  return html`
    <aside class="chat-workspace-rail" aria-label=${t("chat.workspaceFiles.label")}>
      ${
        options.embedded
          ? nothing
          : html`<div class="rail-header chat-workspace-rail__header">
              <div class="rail-header__copy chat-workspace-rail__title">
                <span class="rail-header__eyebrow chat-workspace-rail__eyebrow"
                  >${t("chat.workspaceFiles.workspace")}</span
                >
                <strong class="rail-header__title">${t("chat.workspaceFiles.files")}</strong>
              </div>
              <div class="rail-header__actions chat-workspace-rail__actions">
                ${renderRailHeaderAction({ icon: icons.diff, label: t("chat.sessionDiff.show"), onClick: sessionWorkspace.onOpenDiff, className: "chat-session-diff-toggle" })}
                ${renderRailHeaderAction({ icon: icons.terminal, label: t("terminal.toggle"), onClick: sessionWorkspace.onToggleTerminal })}
                ${renderRailHeaderAction({ icon: icons.globe, label: t("browser.toggle"), onClick: sessionWorkspace.onToggleBrowser })}
                ${renderRailHeaderAction({ icon: icons.lobster, label: t("custodian.panel.toggle"), onClick: sessionWorkspace.onToggleCustodian })}
                ${
                  sessionWorkspace.narrowLayout
                    ? nothing
                    : html`
                        <openclaw-tooltip
                          .content=${
                            dock === "bottom"
                              ? t("chat.workspaceFiles.dockRight")
                              : t("chat.workspaceFiles.dockBottom")
                          }
                        >
                          <button
                            class="rail-header__action chat-workspace-rail__dock"
                            type="button"
                            aria-label=${
                              dock === "bottom"
                                ? t("chat.workspaceFiles.dockRight")
                                : t("chat.workspaceFiles.dockBottom")
                            }
                            @click=${() =>
                              sessionWorkspace.onSetDock(dock === "bottom" ? "right" : "bottom")}
                          >
                            ${dock === "bottom" ? icons.panelRightOpen : icons.panelBottomOpen}
                          </button>
                        </openclaw-tooltip>
                      `
                }
                <openclaw-tooltip .content=${t("chat.workspaceFiles.refresh")}>
                  <button
                    class="rail-header__action chat-workspace-rail__refresh"
                    type="button"
                    aria-label=${t("chat.workspaceFiles.refresh")}
                    ?disabled=${sessionWorkspace.loading}
                    @click=${sessionWorkspace.onRefresh}
                  >
                    ${icons.refresh}
                  </button>
                </openclaw-tooltip>
                <openclaw-tooltip
                  .content=${`${t("chat.workspaceFiles.collapse")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.workspaceFiles)})`}
                >
                  <button
                    type="button"
                    class="rail-header__action chat-workspace-rail__collapse-toggle"
                    aria-label=${t("chat.workspaceFiles.collapse")}
                    aria-keyshortcuts=${isApplePlatform() ? "Meta+Shift+B" : "Control+Shift+B"}
                    aria-expanded="true"
                    @click=${sessionWorkspace.onToggleCollapsed}
                  >
                    <span class="nav-collapse-toggle__icon" aria-hidden="true"
                      >${dock === "bottom" ? icons.panelBottomClose : icons.panelRightClose}</span
                    >
                  </button>
                </openclaw-tooltip>
              </div>
            </div>`
      }
      ${
        sessionWorkspace.list?.root
          ? html`
              <openclaw-tooltip .content=${sessionWorkspace.list.root}>
                <div class="chat-workspace-rail__path">${sessionWorkspace.list.root}</div>
              </openclaw-tooltip>
            `
          : nothing
      }
      <div class="chat-workspace-rail__toolbar">
        <label class="chat-workspace-rail__search">
          <span class="chat-workspace-rail__search-icon" aria-hidden="true">${icons.search}</span>
          <input
            type="search"
            placeholder=${t("chat.workspaceFiles.search")}
            aria-label=${t("chat.workspaceFiles.search")}
            .value=${sessionWorkspace.browserSearch}
            @input=${(event: Event & { currentTarget: HTMLInputElement }) => sessionWorkspace.onSearch(event.currentTarget.value)}
          />
        </label>
        ${
          files.length || artifacts.length
            ? html` <div
                class="chat-workspace-rail__filters"
                role="group"
                aria-label=${t("chat.workspaceFiles.filters")}
              >
                ${filters
                  .filter(({ count }) => count > 0)
                  .map(
                    ({ filter, label }) => html` <button
                      type="button"
                      class="chat-workspace-rail__chip"
                      aria-pressed=${activeFilter === filter}
                      @click=${() => sessionWorkspace.onSetFilter(filter)}
                    >
                      ${label}
                    </button>`,
                  )}
              </div>`
            : nothing
        }
      </div>
      ${
        sessionWorkspace.error
          ? html`<div class="chat-workspace-rail__state chat-workspace-rail__state--error">
              ${sessionWorkspace.error}
            </div>`
          : sessionWorkspace.loading && !hasItems
            ? renderPanelLoadingSkeleton("files", t("chat.workspaceFiles.loading"))
            : html`
                <div class="chat-workspace-rail__scroll">
                  ${renderGroup("changed", t("chat.workspaceFiles.changed"), changed.length, true, renderFileRows(changed))}
                  ${renderGroup("read", t("chat.workspaceFiles.read"), read.length, false, renderFileRows(read))}
                  ${renderGroup("artifacts", t("chat.workspaceFiles.artifacts"), matchingArtifacts.length, false, renderArtifactRows())}
                  ${renderGroup(null, t("chat.workspaceFiles.browser"), entries.length, true, browser ? renderBrowserRows() : nothing)}
                </div>
              `
      }
    </aside>
  `;
}
