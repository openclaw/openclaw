import type { JSX as SolidJSX } from "@solidjs/web";
import { For, onSettled, Show } from "solid-js";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { connectDropdownMenu } from "../../../components/dropdown-menu-controller.ts";
import { promoteToPopoverTopLayer } from "../../../components/menu-surface.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/web-awesome.ts";
import { EDITOR_IDS, EDITOR_LABELS, type EditorId } from "../../../lib/editor-links.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";

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

function MenuItem(props: { value: string; label: SolidJSX.Element; checked?: boolean }) {
  return (
    <wa-dropdown-item
      class={
        props.checked === undefined
          ? "session-menu__item"
          : "session-menu__item session-diff-menu__scope-item"
      }
      value={props.value}
      role={props.checked === undefined ? undefined : "menuitemradio"}
      aria-checked={props.checked === undefined ? undefined : props.checked ? "true" : "false"}
    >
      <span class="session-menu__text">{props.label}</span>
      {props.checked && (
        <span slot="details" class="session-menu__check" aria-hidden="true">
          <Icon name="check" />
        </span>
      )}
    </wa-dropdown-item>
  );
}
function CopyRow(props: { value: string; label: string; command?: boolean }) {
  return (
    <div class={["session-diff-menu__copy-row", { "is-command": props.command }]}>
      <span class="session-diff-menu__copy-label">{props.label}</span>
      <code title={props.value}>{props.value}</code>
      <CopyButton text={props.value} idleLabel={props.label} />
    </div>
  );
}
function SessionDiffMenuContent(
  props: SessionDiffMenuProps,
  host: SolidBridgeElement<SessionDiffMenuProps>,
) {
  onSettled(() => {
    promoteToPopoverTopLayer(host);
    return connectDropdownMenu(
      host,
      { getTrigger: () => props.menu?.trigger ?? null, onClose: () => props.onClose() },
      () => host.updateComplete,
    );
  });
  function run(action: SessionDiffMenuAction) {
    props.onClose();
    props.onAction(action);
  }
  function select(event: CustomEvent<{ item: { value?: string } }>) {
    event.preventDefault();
    const value = event.detail.item.value;
    if (!value) {
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
    const menu = props.menu;
    if (menu?.kind === "file" && (value === "open-file" || value === "reveal-file")) {
      run({ kind: value, path: menu.path });
      return;
    }
    const action = simple[value];
    if (action) {
      run(action);
      return;
    }
    if (value.startsWith("open-editor:")) {
      const editor = EDITOR_IDS.find((id) => value === `open-editor:${id}`);
      if (editor && menu?.kind === "file" && menu.absolutePath) {
        run({ kind: "open-editor", editor, path: menu.absolutePath });
      }
      return;
    }
    if (value.startsWith("scope:commit:")) {
      run({
        kind: "scope",
        value: { scope: "commit", commit: value.slice("scope:commit:".length) },
      });
    }
  }
  function FileMenu(fileProps: { menu: Extract<SessionDiffMenuData, { kind: "file" }> }) {
    return (
      <>
        <CopyRow value={fileProps.menu.path} label={t("chat.sessionDiff.copyPath")} />
        <wa-dropdown-item
          class="session-menu__item"
          value="open-file"
          prop:disabled={!fileProps.menu.canOpenFile}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">
            <Icon name="fileText" />
          </span>
          <span class="session-menu__text">{t("chat.sessionDiff.openFile")}</span>
        </wa-dropdown-item>
        {fileProps.menu.canReveal && (
          <wa-dropdown-item class="session-menu__item" value="reveal-file">
            <span slot="icon" class="session-menu__icon" aria-hidden="true">
              <Icon name="folder" />
            </span>
            <span class="session-menu__text">{t("chat.sessionDiff.revealInFileTree")}</span>
          </wa-dropdown-item>
        )}
        {fileProps.menu.absolutePath && (
          <wa-dropdown-item class="session-menu__item">
            <span slot="icon" class="session-menu__icon" aria-hidden="true">
              <Icon name="externalLink" />
            </span>
            <span class="session-menu__text">{t("chat.sessionDiff.openInEditor")}</span>
            <For each={EDITOR_IDS}>
              {(editor) => (
                <wa-dropdown-item
                  slot="submenu"
                  class="session-menu__item"
                  value={`open-editor:${editor}`}
                >
                  <span class="session-menu__text">{EDITOR_LABELS[editor]}</span>
                </wa-dropdown-item>
              )}
            </For>
          </wa-dropdown-item>
        )}
      </>
    );
  }
  function ScopeMenu(scopeProps: { menu: Extract<SessionDiffMenuData, { kind: "scope" }> }) {
    const activeCommit = () =>
      scopeProps.menu.active.scope === "commit" ? scopeProps.menu.active.commit : null;
    return (
      <>
        <MenuItem
          value="scope:all"
          label={t("chat.sessionDiff.allChanges")}
          checked={scopeProps.menu.active.scope === "all"}
        />
        <MenuItem
          value="scope:uncommitted"
          label={t("chat.sessionDiff.uncommitted")}
          checked={scopeProps.menu.active.scope === "uncommitted"}
        />
        {Boolean(scopeProps.menu.result.commits?.length) && (
          <>
            <div class="session-menu__separator" role="separator" />
            <For each={scopeProps.menu.result.commits}>
              {(commit, index) => (
                <MenuItem
                  value={`scope:commit:${commit.sha}`}
                  checked={activeCommit() === commit.sha}
                  label={
                    <>
                      <span class="session-diff-menu__sha">{commit.sha}</span>
                      <span class="session-diff-menu__subject">{commit.subject}</span>
                      {index() === 0 && (
                        <span class="session-diff-menu__head">{t("chat.sessionDiff.head")}</span>
                      )}
                    </>
                  }
                />
              )}
            </For>
          </>
        )}
        <Show when={scopeProps.menu.result.mergeBase}>
          {(mergeBase) => (
            <>
              <div class="session-menu__separator" role="separator" />
              <div class="session-diff-menu__merge-base">
                <span>{t("chat.sessionDiff.mergeBase")}</span>
                <span class="session-diff-menu__sha">{mergeBase().sha}</span>
                <span class="session-diff-menu__subject">{mergeBase().subject}</span>
              </div>
            </>
          )}
        </Show>
      </>
    );
  }
  function renderContents(menu: SessionDiffMenuData) {
    if (menu.kind === "file") {
      return <FileMenu menu={menu} />;
    }
    if (menu.kind === "scope") {
      return <ScopeMenu menu={menu} />;
    }
    if (menu.kind === "sync") {
      return (
        <div class="session-diff-menu__sync">
          <strong>{t("chat.sessionDiff.syncLocally")}</strong>
          <p>{t("chat.sessionDiff.syncDescription")}</p>
          <CopyRow value={menu.command} label={t("chat.sessionDiff.copyCommand")} command />
          <CopyRow value={menu.root} label={t("chat.sessionDiff.checkoutPath")} />
          <CopyRow value={menu.branch} label={t("chat.sessionDiff.branchName")} />
          <p class="session-diff-menu__note">{t("chat.sessionDiff.uncommittedStay")}</p>
        </div>
      );
    }
    return (
      <>
        <MenuItem value="collapse-all" label={t("chat.sessionDiff.collapseAll")} />
        <MenuItem value="expand-all" label={t("chat.sessionDiff.expandAll")} />
        <div class="session-menu__separator" role="separator" />
        <MenuItem
          value="toggle-wrap"
          label={t(
            menu.wrap ? "chat.sessionDiff.disableWrapping" : "chat.sessionDiff.enableWrapping",
          )}
        />
        <MenuItem
          value="toggle-split"
          label={t(menu.split ? "chat.sessionDiff.switchUnified" : "chat.sessionDiff.switchSplit")}
        />
      </>
    );
  }
  return (
    <Show when={props.menu} keyed>
      {(menu) => {
        const placement = menu.kind === "scope" ? (menu.placement ?? "top-start") : "bottom-end";
        const width = menu.kind === "sync" ? 360 : menu.kind === "scope" ? 340 : 240;
        const label = () =>
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
          <wa-dropdown
            class={`session-menu session-diff-menu session-diff-menu--${menu.kind}`}
            style={{ "--session-diff-menu-width": `${width}px` }}
            prop:open={true}
            placement={placement}
            prop:distance={4}
            aria-label={label()}
            onWa-select={select}
            onWa-after-hide={(event: Event) => {
              if (event.currentTarget instanceof Node && event.currentTarget.isConnected) {
                props.onClose();
              }
            }}
          >
            <button
              slot="trigger"
              type="button"
              tabindex="-1"
              aria-hidden="true"
              style={{
                position: "fixed",
                left: `${Math.max(8, Math.min(menu.anchor.x, window.innerWidth - 8))}px`,
                top: `${Math.max(8, Math.min(menu.anchor.y, window.innerHeight - 8))}px`,
                width: "1px",
                height: "1px",
                opacity: 0,
                "pointer-events": "none",
              }}
            />
            {renderContents(menu)}
          </wa-dropdown>
        );
      }}
    </Show>
  );
}
export const SessionDiffMenu = defineSolidBridge<SessionDiffMenuProps>(
  "openclaw-session-diff-menu",
  SessionDiffMenuContent,
  {
    properties: {
      menu: { default: null, attribute: false },
      onAction: { default: () => {}, attribute: false },
      onClose: { default: () => {}, attribute: false },
    },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-diff-menu": SolidBridgeElement<SessionDiffMenuProps>;
  }
}
