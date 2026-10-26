import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { bindOverlayAnchor } from "../../../components/overlay-anchor.ts";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import {
  createMenuControls,
  Menu,
  type MenuEntry,
  type MenuHandle,
  type MenuItem,
} from "../../../components/solid/menu.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { EDITOR_IDS, EDITOR_LABELS, type EditorId } from "../../../lib/editor-links.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { AttachmentFileIcon } from "./chat-attachment-file-icon-solid.tsx";
import type { SessionDiffScope, SessionDiffFileView } from "./chat-sidebar-content-types.ts";
import { CopyRow, desktopCopyPath } from "./session-diff-copy.tsx";
import {
  SessionDiffOpenIcon,
  SessionDiffActionIcon,
  SessionDiffScopeIcon,
  SessionDiffEditorIcon,
  SessionDiffCollapseIcon,
} from "./session-diff-icons.tsx";
import type { SessionDiffMode } from "./session-diff-preferences.ts";

registerEnglishCatalog(registerChatSessionEnglish);
export { SessionDiffActionIcon } from "./session-diff-icons.tsx";

export type SessionDiffMenuDraft =
  | {
      kind: "file";
      path: string;
      absolutePath?: string;
      canOpenFile: boolean;
      collapsed?: boolean;
      canReveal: boolean;
      desktop?: boolean;
      mobile?: boolean;
      canReadMarkdown?: boolean;
      canEdit?: boolean;
      canViewSource?: boolean;
    }
  | {
      kind: "scope";
      active: SessionDiffScope;
      result: SessionsDiffResult | null;
      placement?: "top-start" | "bottom-start" | "bottom-end";
      desktop?: boolean;
      mobile?: boolean;
    }
  | {
      kind: "sync";
      command: string;
      root: string;
      branch: string;
    }
  | {
      kind: "view";
      split: boolean;
      wrap: boolean;
      desktop?: boolean;
      mobile?: boolean;
      compact?: boolean;
      allExpanded?: boolean;
      hasFiles?: boolean;
      mode?: SessionDiffMode;
      wordDiffs?: boolean;
      sync?: { command: string; root: string; branch: string };
      canOpenSync?: boolean;
    }
  | { kind: "jump"; paths: string[]; selected: string | null };

export type SessionDiffMenuData = SessionDiffMenuDraft & {
  trigger: HTMLElement;
};

export type SessionDiffMenuAction =
  | { kind: "collapse-code" | "collapse-functions" | "expand-code"; path: string }
  | { kind: "collapse-all" }
  | { kind: "expand-all" }
  | { kind: "open-editor"; editor: EditorId; path: string }
  | { kind: "open-file"; path: string }
  | { kind: "reveal-file"; path: string }
  | { kind: "scope"; value: SessionDiffScope }
  | { kind: "toggle-split" }
  | { kind: "toggle-wrap" };
export type SessionDiffDesktopMenuAction =
  | { kind: "toggle-file"; path: string }
  | { kind: "mode"; value: SessionDiffMode }
  | { kind: "toggle-word-diffs" }
  | { kind: "jump"; path: string }
  | {
      kind: "sync";
      data: { command: string; root: string; branch: string };
      trigger: HTMLElement;
    }
  | { kind: "open-file-view"; path: string; view: SessionDiffFileView };

type SessionDiffMenuProps = {
  menu: SessionDiffMenuData | null;
  onAction: (action: SessionDiffMenuAction | SessionDiffDesktopMenuAction) => void;
  onClose: () => void;
};

function menuItem(
  id: string,
  label: string,
  checked?: boolean,
  content?: SolidJSX.Element,
): MenuItem {
  return {
    id,
    label,
    class: ["session-menu__item", { "session-diff-menu__scope-item": checked !== undefined }],
    type: checked === undefined ? undefined : "radio",
    checked,
    content: <span class="session-menu__text">{content ?? label}</span>,
    details: checked ? (
      <span class="session-menu__check" aria-hidden="true">
        <Icon name="check" />
      </span>
    ) : undefined,
  };
}
function separator(id: string): MenuEntry {
  return { kind: "content", id, content: <div class="session-menu__separator" role="separator" /> };
}
let nextMenuId = 0;
export function SessionDiffMenu(props: SessionDiffMenuProps) {
  const id = `session-diff-menu-${++nextMenuId}`;
  const controls = createMenuControls();
  // Search belongs to one opened menu, not the next menu's target.
  const [jumpQuery, setJumpQuery] = createSignal(() => {
    void props.menu;
    return "";
  });
  const jumpSearch: MenuEntry = {
    kind: "content",
    id: "jump-search",
    content: (
      <input
        ref={controls.ref()}
        class="session-diff-menu__search"
        type="search"
        data-search=""
        data-initial-focus=""
        data-form-control=""
        aria-label={t("chat.sessionDiff.searchFiles")}
        placeholder={t("chat.sessionDiff.searchFiles")}
        value={jumpQuery()}
        onInput={(event) => setJumpQuery(event.currentTarget.value)}
      />
    ),
  };
  function select(value: string, menu: SessionDiffMenuData) {
    if (value === "toggle-file" && menu.kind === "file") {
      props.onAction({ kind: "toggle-file", path: menu.path });
      return;
    }
    if (menu.kind === "jump") {
      const path = menu.paths.find((_, index) => value === `jump:${index}`);
      if (path) {
        props.onAction({ kind: "jump", path });
      }
      return;
    }
    if (menu.kind === "view") {
      if (value === "word-diffs") {
        props.onAction({ kind: "toggle-word-diffs" });
        return;
      }
      if (value === "sync" && menu.sync) {
        props.onAction({
          kind: "sync",
          data: menu.sync,
          trigger: menu.trigger,
        });
        return;
      }
      const mode = (["auto", "unified", "split"] as const).find(
        (candidate) => value === `mode:${candidate}`,
      );
      if (mode) {
        props.onAction({ kind: "mode", value: mode });
        return;
      }
    }
    if (
      menu.kind === "file" &&
      (value === "reading" || value === "highlighted" || value === "plain" || value === "edit")
    ) {
      props.onAction({ kind: "open-file-view", path: menu.path, view: value });
      return;
    }
    const simple: Record<string, SessionDiffMenuAction | undefined> = {
      "collapse-all": { kind: "collapse-all" },
      "expand-all": { kind: "expand-all" },
      "toggle-split": { kind: "toggle-split" },
      "toggle-wrap": { kind: "toggle-wrap" },
      "scope:all": { kind: "scope", value: { scope: "all" } },
      "scope:uncommitted": { kind: "scope", value: { scope: "uncommitted" } },
    };
    let action = simple[value];
    if (
      menu.kind === "file" &&
      (value === "open-file" ||
        value === "reveal-file" ||
        value === "collapse-code" ||
        value === "collapse-functions" ||
        value === "expand-code")
    ) {
      action = { kind: value, path: menu.path };
    } else if (value.startsWith("open-editor:") && menu.kind === "file" && menu.absolutePath) {
      const editor = EDITOR_IDS.find((candidate) => value === `open-editor:${candidate}`);
      if (editor) {
        action = { kind: "open-editor", editor, path: menu.absolutePath };
      }
    } else if (value.startsWith("scope:commit:")) {
      action = {
        kind: "scope",
        value: { scope: "commit", commit: value.slice("scope:commit:".length) },
      };
    }
    if (action) {
      props.onAction(action);
    }
  }
  function rawItems(
    menu: SessionDiffMenuData,
    onCopyButtonRef: (button: HTMLButtonElement) => void,
  ): MenuEntry[] {
    if (menu.kind === "jump") {
      const query = jumpQuery().trim().toLocaleLowerCase();
      const matches = menu.paths.flatMap((path, index) => {
        if (!path.toLocaleLowerCase().includes(query)) {
          return [];
        }
        const slash = path.lastIndexOf("/");
        return [
          {
            ...menuItem(
              `jump:${index}`,
              path,
              path === menu.selected,
              <span class="session-diff-menu__jump-path">
                <span>{path.slice(slash + 1)}</span>
                <small ref={createTextOverflow(() => path)} title={path}>
                  {path.slice(0, Math.max(0, slash))}
                </small>
              </span>,
            ),
            icon: <AttachmentFileIcon filename={path} mode="preview-with-favicon" />,
          },
        ];
      });
      return [
        jumpSearch,
        ...matches,
        ...(matches.length
          ? []
          : [
              {
                kind: "content" as const,
                id: "no-results",
                content: <span class="muted">{t("chat.sessionDiff.noMatchingFiles")}</span>,
              },
            ]),
      ];
    }
    if (menu.kind === "file") {
      const openActions: MenuEntry[] = [
        {
          ...menuItem("open-file", t("chat.sessionDiff.openFile")),
          disabled: !menu.canOpenFile,
          icon: (
            <span class="session-menu__icon" aria-hidden="true">
              <SessionDiffOpenIcon />
            </span>
          ),
        },
        ...(menu.canReveal
          ? [
              {
                ...menuItem("reveal-file", t("chat.sessionDiff.revealInFileTree")),
                icon: (
                  <span class="session-menu__icon" aria-hidden="true">
                    <Icon name="folder" />
                  </span>
                ),
              },
            ]
          : []),
        ...(menu.absolutePath
          ? [
              {
                ...menuItem("open-editor", t("chat.sessionDiff.openInEditor")),
                content: undefined,
                icon: (
                  <span class="session-menu__icon" aria-hidden="true">
                    <Icon name="externalLink" />
                  </span>
                ),
                children: EDITOR_IDS.map((editor) =>
                  Object.assign(menuItem(`open-editor:${editor}`, EDITOR_LABELS[editor]), {
                    icon: menu.desktop ? <SessionDiffEditorIcon /> : undefined,
                  }),
                ),
              },
            ]
          : []),
      ];
      const readingActions = [
        ...(menu.canReadMarkdown ? [menuItem("reading", t("chat.sessionDiff.readMarkdown"))] : []),
        ...(menu.canViewSource
          ? [
              menuItem("highlighted", t("chat.sessionDiff.readHighlighted")),
              menuItem("plain", t("chat.sessionDiff.readPlain")),
            ]
          : []),
      ];
      const editActions = menu.canEdit ? [menuItem("edit", t("chat.sessionDiff.editFile"))] : [];
      const codeActions = [
        menuItem("collapse-code", t("chat.sessionDiff.collapseCode")),
        menuItem("collapse-functions", t("chat.sessionDiff.collapseFunctions")),
        menuItem("expand-code", t("chat.sessionDiff.expandCode")),
      ];
      if (menu.desktop) {
        return [
          desktopCopyPath(menu.path, onCopyButtonRef),
          openActions[0]!,
          ...editActions,
          {
            ...menuItem(
              "toggle-file",
              t(menu.collapsed ? "chat.sessionDiff.expandFile" : "chat.sessionDiff.collapseFile"),
            ),
            icon: menu.collapsed ? <Icon name="chevronsUpDown" /> : <SessionDiffCollapseIcon />,
          },
          ...(readingActions.length ? [separator("reading"), ...readingActions] : []),
          ...(openActions.length > 1 ? [separator("locations"), ...openActions.slice(1)] : []),
          separator("code-actions"),
          ...codeActions,
        ];
      }
      return [
        ...readingActions,
        ...editActions,
        ...codeActions,
        separator("code-actions"),
        {
          kind: "content",
          id: "path",
          content: (
            <CopyRow
              ref={controls.ref()}
              value={menu.path}
              label={t("chat.sessionDiff.copyPath")}
              initialFocus
            />
          ),
        },
        ...openActions,
      ];
    }
    if (menu.kind === "scope") {
      return [
        menuItem("scope:all", t("chat.sessionDiff.allChanges"), menu.active.scope === "all"),
        menuItem(
          "scope:uncommitted",
          t("chat.sessionDiff.uncommitted"),
          menu.active.scope === "uncommitted",
        ),
        ...(menu.result?.commits?.length
          ? [
              separator("commits"),
              ...(menu.desktop
                ? [
                    {
                      ...menuItem("commits", t("chat.sessionDiff.commits")),
                      children: menu.result.commits.map((commit) => ({
                        ...menuItem(
                          `scope:commit:${commit.sha}`,
                          `${commit.sha} ${commit.subject}`,
                          menu.active.scope === "commit" && menu.active.commit === commit.sha,
                        ),
                        icon: <SessionDiffScopeIcon action="commit" />,
                      })),
                    },
                  ]
                : menu.result.commits.map((commit, index) =>
                    menuItem(
                      `scope:commit:${commit.sha}`,
                      `${commit.sha} ${commit.subject}`,
                      menu.active.scope === "commit" && menu.active.commit === commit.sha,
                      <>
                        <span class="session-diff-menu__sha">{commit.sha}</span>
                        <span
                          ref={createTextOverflow(() => commit.subject)}
                          class="session-diff-menu__subject"
                          title={commit.subject}
                        >
                          {commit.subject}
                        </span>
                        {index === 0 && (
                          <span class="session-diff-menu__head">{t("chat.sessionDiff.head")}</span>
                        )}
                      </>,
                    ),
                  )),
            ]
          : []),
        ...(menu.result?.mergeBase
          ? [
              separator("merge-base-divider"),
              {
                kind: "content" as const,
                id: "merge-base",
                content: (
                  <div class="session-diff-menu__merge-base">
                    <span>{t("chat.sessionDiff.mergeBase")}</span>
                    <span class="session-diff-menu__sha">{menu.result.mergeBase.sha}</span>
                    <span
                      ref={createTextOverflow(() => menu.result?.mergeBase?.subject)}
                      class="session-diff-menu__subject"
                      title={menu.result.mergeBase.subject}
                    >
                      {menu.result.mergeBase.subject}
                    </span>
                  </div>
                ),
              },
            ]
          : []),
      ];
    }
    if (menu.kind === "sync") {
      return [
        {
          kind: "content",
          id: "sync",
          content: (
            <div class="session-diff-menu__sync">
              <strong>{t("chat.sessionDiff.syncLocally")}</strong>
              <p>{t("chat.sessionDiff.syncDescription")}</p>
              <CopyRow
                ref={controls.ref()}
                value={menu.command}
                label={t("chat.sessionDiff.copyCommand")}
                command
                initialFocus
              />
              <CopyRow
                ref={controls.ref()}
                value={menu.root}
                label={t("chat.sessionDiff.checkoutPath")}
              />
              <CopyRow
                ref={controls.ref()}
                value={menu.branch}
                label={t("chat.sessionDiff.branchName")}
              />
              <p class="session-diff-menu__note">{t("chat.sessionDiff.uncommittedStay")}</p>
            </div>
          ),
        },
      ];
    }
    if (menu.desktop) {
      return [
        ...(menu.compact
          ? [
              ...(["auto", "unified", "split"] as const).map((mode) =>
                Object.assign(
                  menuItem(
                    `mode:${mode}`,
                    t(
                      `chat.sessionDiff.mode${mode === "auto" ? "Auto" : mode === "unified" ? "Unified" : "Split"}`,
                    ),
                    (menu.mode ?? "auto") === mode,
                  ),
                  {
                    icon: <Icon name="columns2" />,
                  },
                ),
              ),
              {
                ...menuItem("toggle-wrap", t("chat.sessionDiff.wrapLines"), menu.wrap),
                type: "checkbox" as const,
                icon: <Icon name="wrapText" />,
              },
              separator("comparison"),
            ]
          : []),
        {
          ...menuItem("word-diffs", t("chat.sessionDiff.wordDiffs"), menu.wordDiffs !== false),
          type: "checkbox",
          icon: <Icon name="diff" />,
        },
        ...(menu.compact
          ? [
              separator("disclosure"),
              {
                ...menuItem(
                  menu.allExpanded ? "collapse-all" : "expand-all",
                  t(
                    menu.allExpanded
                      ? "chat.sessionDiff.collapseAll"
                      : "chat.sessionDiff.expandAll",
                  ),
                ),
                disabled: !menu.hasFiles,
                icon: <SessionDiffActionIcon action={menu.allExpanded ? "collapse" : "expand"} />,
              },
            ]
          : []),
        ...(menu.sync
          ? [
              separator("sync"),
              {
                ...menuItem("sync", t("chat.sessionDiff.syncLocally")),
                icon: <Icon name="arrowLeftRight" />,
              },
            ]
          : []),
      ];
    }
    return [
      menuItem("collapse-all", t("chat.sessionDiff.collapseAll")),
      menuItem("expand-all", t("chat.sessionDiff.expandAll")),
      separator("view"),
      menuItem(
        "toggle-wrap",
        t(menu.wrap ? "chat.sessionDiff.disableWrapping" : "chat.sessionDiff.enableWrapping"),
      ),
      menuItem(
        "toggle-split",
        t(menu.split ? "chat.sessionDiff.switchUnified" : "chat.sessionDiff.switchSplit"),
      ),
      ...(menu.mobile && menu.sync
        ? [
            separator("sync"),
            { ...menuItem("sync", t("chat.sessionDiff.syncLocally")), disabled: !menu.canOpenSync },
          ]
        : []),
    ];
  }
  function items(
    menu: SessionDiffMenuData,
    onCopyButtonRef: (button: HTMLButtonElement) => void,
  ): MenuEntry[] {
    const entries = rawItems(menu, onCopyButtonRef);
    const desktop = "desktop" in menu && menu.desktop;
    if (!desktop && (!("mobile" in menu) || !menu.mobile)) {
      return entries;
    }
    const icons: Record<string, IconName> = desktop
      ? {
          "scope:all": "gitBranch",
          reading: "eye",
          highlighted: "codeXml",
          plain: "fileText",
          edit: "pencil",
          "collapse-code": "foldVertical",
          "collapse-functions": "listTree",
          "expand-code": "chevronsUpDown",
        }
      : {
          "scope:all": "fileDiff",
          "scope:uncommitted": "diff",
          "collapse-all": "chevronUp",
          "expand-all": "chevronDown",
          "toggle-wrap": "wrapText",
          "toggle-split": "columns2",
          sync: "arrowLeftRight",
          "collapse-code": "chevronUp",
          "collapse-functions": "listTree",
          "expand-code": "chevronDown",
        };
    return entries.map((entry) => {
      if (!("label" in entry) || entry.icon) {
        return entry;
      }
      if (desktop) {
        const action =
          entry.id === "scope:uncommitted"
            ? "uncommitted"
            : entry.id === "commits"
              ? "commit"
              : undefined;
        entry.icon = action ? (
          <SessionDiffScopeIcon action={action} />
        ) : icons[entry.id] ? (
          <Icon name={icons[entry.id]!} />
        ) : undefined;
        return entry;
      }
      const icon = entry.id.startsWith("scope:commit:") ? "history" : icons[entry.id];
      if (icon) {
        entry.icon = (
          <span class="session-menu__icon" aria-hidden="true">
            <Icon name={icon} />
          </span>
        );
      }
      return entry;
    });
  }
  return (
    <openclaw-session-diff-menu>
      <Show when={props.menu} keyed>
        {(menu) => {
          let handle: MenuHandle | undefined;
          let copyPathButton: HTMLButtonElement | undefined;
          let releaseAnchor: (() => void) | undefined;
          onSettled(() => () => releaseAnchor?.());
          const placement = menu.kind === "scope" ? (menu.placement ?? "top-start") : "bottom-end";
          const entries = createMemo(() =>
            items(menu, (button) => {
              copyPathButton = button;
            }),
          );
          const label = () =>
            menu.kind === "file"
              ? t("chat.sessionDiff.fileActions", { path: menu.path })
              : t(
                  menu.kind === "scope"
                    ? "chat.sessionDiff.scopeMenu"
                    : menu.kind === "jump"
                      ? "chat.sessionDiff.jumpToFile"
                      : menu.kind === "sync"
                        ? "chat.sessionDiff.syncLocally"
                        : "chat.sessionDiff.viewOptions",
                );
          return (
            <div
              style={{
                "--session-diff-menu-width": `${menu.kind === "sync" ? 360 : menu.kind === "scope" ? 340 : 240}px`,
              }}
            >
              <Menu
                controls={controls}
                id={id}
                class={[
                  "session-menu session-diff-menu",
                  `session-diff-menu--${menu.kind}`,
                  {
                    "session-diff-menu--mobile": "mobile" in menu && menu.mobile,
                    "session-diff-menu--desktop": "desktop" in menu && menu.desktop,
                  },
                ]}
                panelClass="session-diff-menu__surface"
                placement={placement}
                label={label()}
                items={entries()}
                triggerAttributes={{
                  tabindex: -1,
                  "aria-hidden": "true",
                  style: { display: "none" },
                }}
                ref={(value) => {
                  handle = value;
                  releaseAnchor?.();
                  // Follow the real button through translated sheets; CSS owns placement and flipping.
                  releaseAnchor = bindOverlayAnchor(value.overlay.surface, menu.trigger, placement);
                  value.overlay.setReturnTarget(menu.trigger);
                  value.open();
                }}
                onSelect={(item, event) => {
                  event.preventDefault();
                  if (item.id === "copy-path") {
                    return;
                  }
                  handle?.close();
                  select(item.id, menu);
                }}
                onBeforeHide={(event) => {
                  // Clipboard fallback briefly leaves focus on body before restoring the button.
                  // Keep its native outcome/status mounted through that focus-only dismissal.
                  if (
                    document.activeElement === document.body &&
                    copyPathButton?.dataset.copyState === "copying"
                  ) {
                    event.preventDefault();
                  }
                }}
                onOpenChange={(open) => {
                  if (!open && props.menu === menu && handle?.overlay.surface.isConnected) {
                    props.onClose();
                  }
                }}
              />
            </div>
          );
        }}
      </Show>
    </openclaw-session-diff-menu>
  );
}
