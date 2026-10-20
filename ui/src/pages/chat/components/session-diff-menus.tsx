import type { JSX as SolidJSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import {
  createMenuControls,
  Menu,
  type MenuEntry,
  type MenuHandle,
  type MenuItem,
} from "../../../components/solid/menu.tsx";
import { EDITOR_IDS, EDITOR_LABELS, type EditorId } from "../../../lib/editor-links.ts";
import { t } from "../../../lib/reactive/i18n.ts";

export type SessionDiffScope =
  | { scope: "all" | "uncommitted" }
  | { scope: "commit"; commit: string };

type MenuAnchor = { x: number; y: number };

export type SessionDiffMenuDraft =
  | {
      kind: "file";
      path: string;
      absolutePath?: string;
      canOpenFile: boolean;
      canReveal: boolean;
    }
  | {
      kind: "scope";
      active: SessionDiffScope;
      result: SessionsDiffResult;
      placement?: "top-start" | "bottom-start";
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
    };

export type SessionDiffMenuData = SessionDiffMenuDraft & {
  anchor: MenuAnchor;
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

type SessionDiffMenuProps = {
  menu: SessionDiffMenuData | null;
  onAction: (action: SessionDiffMenuAction) => void;
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
function CopyRow(props: {
  value: string;
  label: string;
  command?: boolean;
  initialFocus?: boolean;
  ref?: (element: HTMLButtonElement) => void;
}) {
  return (
    <div class={["session-diff-menu__copy-row", { "is-command": props.command }]}>
      <span class="session-diff-menu__copy-label">{props.label}</span>
      <code title={props.value}>{props.value}</code>
      <CopyButton
        ref={props.ref}
        text={props.value}
        idleLabel={props.label}
        buttonAttributes={{
          "data-form-control": "",
          "data-initial-focus": props.initialFocus ? "" : undefined,
        }}
      />
    </div>
  );
}
let nextMenuId = 0;
export function SessionDiffMenu(props: SessionDiffMenuProps) {
  const id = `session-diff-menu-${++nextMenuId}`;
  const controls = createMenuControls();
  function select(value: string, menu: SessionDiffMenuData) {
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
  function items(menu: SessionDiffMenuData): MenuEntry[] {
    if (menu.kind === "file") {
      return [
        menuItem("collapse-code", t("chat.sessionDiff.collapseCode")),
        menuItem("collapse-functions", t("chat.sessionDiff.collapseFunctions")),
        menuItem("expand-code", t("chat.sessionDiff.expandCode")),
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
        {
          ...menuItem("open-file", t("chat.sessionDiff.openFile")),
          disabled: !menu.canOpenFile,
          icon: (
            <span class="session-menu__icon" aria-hidden="true">
              <Icon name="fileText" />
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
                  menuItem(`open-editor:${editor}`, EDITOR_LABELS[editor]),
                ),
              },
            ]
          : []),
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
        ...(menu.result.commits?.length
          ? [
              separator("commits"),
              ...menu.result.commits.map((commit, index) =>
                menuItem(
                  `scope:commit:${commit.sha}`,
                  `${commit.sha} ${commit.subject}`,
                  menu.active.scope === "commit" && menu.active.commit === commit.sha,
                  <>
                    <span class="session-diff-menu__sha">{commit.sha}</span>
                    <span class="session-diff-menu__subject">{commit.subject}</span>
                    {index === 0 && (
                      <span class="session-diff-menu__head">{t("chat.sessionDiff.head")}</span>
                    )}
                  </>,
                ),
              ),
            ]
          : []),
        ...(menu.result.mergeBase
          ? [
              separator("merge-base-divider"),
              {
                kind: "content" as const,
                id: "merge-base",
                content: (
                  <div class="session-diff-menu__merge-base">
                    <span>{t("chat.sessionDiff.mergeBase")}</span>
                    <span class="session-diff-menu__sha">{menu.result.mergeBase.sha}</span>
                    <span class="session-diff-menu__subject">{menu.result.mergeBase.subject}</span>
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
    ];
  }
  return (
    <openclaw-session-diff-menu>
      <Show when={props.menu} keyed>
        {(menu) => {
          let handle: MenuHandle | undefined;
          const placement = menu.kind === "scope" ? (menu.placement ?? "top-start") : "bottom-end";
          const entries = items(menu);
          const label =
            menu.kind === "file"
              ? t("chat.sessionDiff.fileActions", { path: menu.path })
              : t(
                  menu.kind === "scope"
                    ? "chat.sessionDiff.scopeMenu"
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
                class={["session-menu session-diff-menu", `session-diff-menu--${menu.kind}`]}
                panelClass="session-diff-menu__surface"
                placement={placement}
                label={label}
                items={entries}
                triggerAttributes={{
                  tabindex: -1,
                  "aria-hidden": "true",
                  style: {
                    position: "fixed",
                    left: `${Math.max(8, Math.min(menu.anchor.x, window.innerWidth - 8))}px`,
                    top: `${Math.max(8, Math.min(menu.anchor.y, window.innerHeight - 8))}px`,
                    width: "1px",
                    height: "1px",
                    opacity: 0,
                    "pointer-events": "none",
                  },
                }}
                ref={(value) => {
                  handle = value;
                  value.overlay.setReturnTarget(menu.trigger);
                  value.open();
                }}
                onSelect={(item, event) => {
                  event.preventDefault();
                  handle?.close();
                  select(item.id, menu);
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
