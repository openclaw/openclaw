import type { JSX } from "@solidjs/web";
import { Show, createUniqueId, onSettled } from "solid-js";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerCodeBlocksEnglish } from "../../../i18n/locales/en-code-blocks.ts";
import "../../../components/tooltip.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import type { FileCopyFeedback } from "./chat-file-copy.ts";
import type { MobileFileFindCloseReason, FileViewControls } from "./chat-file-reader-controls.ts";
import type { FileHtmlPreviewControls } from "./chat-html-preview.ts";
import "./chat-sidebar-file-mobile.css";
import type { MobileFileBack } from "./chat-sidebar-content-types.ts";

registerEnglishCatalog(registerChatSessionEnglish);

registerCodeBlocksEnglish();
registerFilePreviewEnglish();

export type MobileFileMenuAction = {
  id: string;
  label: string;
  icon: IconName;
  disabled?: boolean;
  checked?: boolean;
  onSelect: () => void;
};

type MobileFileReadMode = Pick<FileHtmlPreviewControls, "source" | "onToggle">;

export type SidebarFileMobileRailProps = {
  name: string;
  /** Full identity for the tooltip; never derive a local path from an artifact URL. */
  identity: string;
  back?: MobileFileBack;
  menuActions?: readonly MobileFileMenuAction[];
  attachment?: import("./chat-file-session-attachment.ts").FileSessionAttachment;
  /** Native Download, attachment Copy, MCP or external-editor controls, as eligible. */
  actions?: JSX.Element;
};

function MobileFileButton(props: {
  label: string;
  icon: IconName;
  onClick: () => void;
  disabled?: boolean;
  tooltip?: boolean;
  class?: string;
  ref?: (element: HTMLButtonElement) => void;
}) {
  return (
    <openclaw-tooltip prop:content={props.tooltip === false ? "" : props.label}>
      <button
        type="button"
        class={["sidebar-file-mobile__button", props.class]}
        aria-label={props.label}
        disabled={props.disabled}
        ref={(element) => props.ref?.(element)}
        onClick={() => props.onClick()}
      >
        <Icon name={props.icon} />
      </button>
    </openclaw-tooltip>
  );
}

/** Mount separately from the document so changing chrome never replaces its editor/player. */
export function SidebarFileMobileRail(props: SidebarFileMobileRailProps) {
  const id = createUniqueId();
  const actions = (): readonly MobileFileMenuAction[] => [
    ...(props.attachment
      ? [
          {
            id: "attach-session",
            label: t("chat.detailPanel.attachToSession"),
            icon: "paperclip" as const,
            disabled: props.attachment.disabled,
            onSelect: props.attachment.attach,
          },
        ]
      : []),
    ...(props.menuActions ?? []),
  ];
  return (
    <div class="sidebar-file-mobile__rail">
      <Show when={props.back}>
        {(back) => (
          <MobileFileButton
            label={back().label}
            icon="chevronLeft"
            onClick={() => back().onBack()}
          />
        )}
      </Show>
      <span class="sidebar-file-mobile__identity" aria-label={props.identity}>
        <span class="sidebar-file-mobile__name">{props.name}</span>
      </span>
      <div class="sidebar-file-mobile__rail-actions">
        {props.actions}
        <Show when={actions().length}>
          <Menu
            id={`mobile-file-${id}`}
            label={t("chat.workspaceFiles.actions")}
            placement="bottom-end"
            triggerClass="sidebar-file-mobile__button"
            trigger={<Icon name="moreHorizontal" />}
            items={actions().map((action) => ({
              id: action.id,
              label: action.label,
              icon: <Icon name={action.icon} />,
              disabled: action.disabled,
              type: action.checked === undefined ? undefined : "checkbox",
              checked: action.checked,
            }))}
            onSelect={(item) =>
              actions()
                .find((action) => action.id === item.id)
                ?.onSelect()
            }
          />
        </Show>
      </div>
    </div>
  );
}

/** Called in the parent's reactive render; callbacks and copy feedback stay with FileViewControls. */
export function mobileFileTextMenuActions(options: {
  controls: FileViewControls;
  path?: string;
  source: boolean;
}): MobileFileMenuAction[] {
  const { controls, path, source } = options;
  const copy = (action: "contents" | "path"): MobileFileMenuAction => ({
    id: `copy-${action}`,
    label: t(
      controls.copyFeedback[action] === "failed"
        ? "common.copyFailed"
        : controls.copyFeedback[action] === "copied"
          ? "common.copied"
          : action === "path"
            ? "chat.detailPanel.copyPath"
            : "chat.detailPanel.copyContents",
    ),
    icon: controls.copyFeedback[action] === "copied" ? "check" : "copy",
    onSelect: () => controls.onCopy(action),
  });
  const actions: MobileFileMenuAction[] = [
    ...(controls.fileAttachment
      ? [
          {
            id: "attach-session",
            label: t("chat.detailPanel.attachToSession"),
            icon: "paperclip" as const,
            disabled: controls.fileAttachment.disabled,
            onSelect: controls.fileAttachment.attach,
          },
        ]
      : []),
    copy("contents"),
  ];
  if (path) {
    actions.push(copy("path"));
    if (controls.onReveal) {
      actions.push({
        id: "show-in-files",
        label: t("chat.detailPanel.showInFiles"),
        icon: "folder",
        onSelect: () => controls.onReveal?.(path),
      });
    }
  }
  if (source) {
    actions.push({
      id: "wrap",
      label: t(controls.wrap ? "chat.codeBlock.disableWrap" : "chat.codeBlock.enableWrap"),
      icon: "wrapText",
      checked: controls.wrap,
      onSelect: () => controls.onToggleWrap(),
    });
  }
  return actions;
}

export type SidebarFileMobileTextControlsProps = {
  controls: FileViewControls;
  canEdit: boolean;
  /** Omit for code/plain text/CSV. Markdown and HTML share this two-mode contract. */
  mode?: MobileFileReadMode;
  /** False for retained tabs/routes that are not currently presented. */
  active: boolean;
  /** One owner operation clears matches/query and restores the prior mode and appropriate focus. */
  onCloseFind: (reason: MobileFileFindCloseReason) => void;
};

export function SidebarFileMobileTextControls(props: SidebarFileMobileTextControlsProps) {
  let root!: HTMLDivElement;
  let find: HTMLDivElement | undefined;
  onSettled(() => {
    const document = root.ownerDocument;
    const outside = (event: PointerEvent) => {
      if (
        !props.active ||
        !props.controls.searchOpen ||
        props.controls.editing ||
        root.closest("[inert], [hidden]") ||
        !root.checkVisibility({ checkVisibilityCSS: true }) ||
        (find && event.composedPath().includes(find))
      ) {
        return;
      }
      // Do not cancel the press: Back, a menu or the document still receives its normal action.
      props.onCloseFind("outside");
    };
    return listen(document, "pointerdown", outside, true);
  });
  return (
    <div class="sidebar-file-mobile__floating" ref={(element) => (root = element)}>
      <Show when={!props.controls.editing && !props.controls.searchOpen && props.mode}>
        {(mode) => (
          <div
            class={[
              "sidebar-file-mobile__capsule sidebar-file-mobile__mode",
              { "sidebar-file-mobile__mode--source": mode().source },
            ]}
          >
            <MobileFileButton
              label={t(
                mode().source ? "chat.workspaceFiles.preview" : "chat.detailPanel.viewSource",
              )}
              icon={mode().source ? "bookOpenText" : "fileCode"}
              onClick={() => mode().onToggle()}
            />
          </div>
        )}
      </Show>
      <Show
        when={props.controls.editing}
        fallback={
          <Show
            when={props.controls.searchOpen}
            fallback={
              <div class="sidebar-file-mobile__capsule sidebar-file-mobile__reading">
                <Show when={props.canEdit}>
                  <MobileFileButton
                    label={t("chat.detailPanel.editFile")}
                    icon="edit"
                    onClick={() => props.controls.onEdit()}
                    disabled={props.controls.loadingEditor}
                  />
                  <span class="sidebar-file-mobile__divider" aria-hidden="true" />
                </Show>
                <MobileFileButton
                  label={t("chat.detailPanel.searchInFile")}
                  icon="search"
                  ref={(element) => props.controls.searchToggleRef?.(element)}
                  onClick={() => props.controls.onToggleSearch()}
                  disabled={props.controls.loadingEditor}
                />
              </div>
            }
          >
            <div
              class="sidebar-file-mobile__capsule sidebar-file-mobile__find"
              ref={(element) => (find = element)}
              role="search"
              aria-label={t("chat.detailPanel.searchInFile")}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !event.isComposing) {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onCloseFind("escape");
                }
              }}
            >
              <input
                class="sidebar-file-mobile__query"
                type="search"
                aria-label={t("chat.detailPanel.searchInFile")}
                placeholder={t("common.search")}
                ref={(element) => props.controls.searchInputRef?.(element)}
                value={props.controls.query}
                onInput={(event) => props.controls.onSearchInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") {
                    props.controls.onSearchKeydown(event);
                  }
                }}
              />
              <Show when={props.controls.query.length > 0}>
                <span class="sidebar-file-mobile__counter" role="status">
                  {props.controls.matches.length ? props.controls.currentMatchIndex + 1 : 0}/
                  {props.controls.matches.length}
                </span>
                <MobileFileButton
                  label={t("chat.detailPanel.previousMatch")}
                  icon="chevronUp"
                  disabled={!props.controls.matches.length}
                  onClick={() => props.controls.onPreviousMatch()}
                />
                <MobileFileButton
                  label={t("chat.detailPanel.nextMatch")}
                  icon="chevronDown"
                  disabled={!props.controls.matches.length}
                  onClick={() => props.controls.onNextMatch()}
                />
              </Show>
              <MobileFileButton
                label={t("common.close")}
                icon="x"
                onClick={() => props.onCloseFind("close")}
              />
            </div>
          </Show>
        }
      >
        <div class="sidebar-file-mobile__capsule sidebar-file-mobile__editing">
          <button
            type="button"
            class="sidebar-file-mobile__button sidebar-file-mobile__text-action"
            disabled={props.controls.saving}
            onClick={() => props.controls.onDiscard()}
          >
            {t("chat.detailPanel.discard")}
          </button>
          <span class="sidebar-file-mobile__divider" aria-hidden="true" />
          <button
            type="button"
            class="sidebar-file-mobile__button sidebar-file-mobile__text-action sidebar-file-mobile__save"
            disabled={
              !props.canEdit ||
              !props.controls.dirty ||
              props.controls.saving ||
              props.controls.loadingEditor
            }
            aria-busy={props.controls.saving ? "true" : "false"}
            aria-label={t(props.controls.saving ? "common.saving" : "common.save")}
            onClick={() => props.controls.onSave()}
          >
            {t("common.save")}
          </button>
        </div>
      </Show>
    </div>
  );
}

export type SidebarFileMobileImageControlsProps = {
  name: string;
  /** Supplied only for an eligible path, with the native copy operation/feedback. */
  copyPath?: { onCopy: () => void; feedback?: FileCopyFeedback["path"] };
  /** Opens the existing image lightbox with its real image/gallery context. */
  onExpand: () => void;
};

export function SidebarFileMobileImageControls(props: SidebarFileMobileImageControlsProps) {
  return (
    <div class="sidebar-file-mobile__floating">
      <div class="sidebar-file-mobile__capsule sidebar-file-mobile__image">
        <Show when={props.copyPath}>
          {(copy) => (
            <>
              <MobileFileButton
                label={t(
                  copy().feedback === "failed"
                    ? "common.copyFailed"
                    : copy().feedback === "copied"
                      ? "common.copied"
                      : "chat.detailPanel.copyPath",
                )}
                icon={copy().feedback === "copied" ? "check" : "copy"}
                onClick={() => copy().onCopy()}
              />
              <span class="sidebar-file-mobile__divider" aria-hidden="true" />
            </>
          )}
        </Show>
        <MobileFileButton
          label={t("chat.imageLightbox.open", { title: props.name })}
          icon="maximize"
          tooltip={false}
          onClick={() => props.onExpand()}
        />
      </div>
    </div>
  );
}
