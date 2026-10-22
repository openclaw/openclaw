import { createUniqueId, Show } from "solid-js";
import { localEditorFilePath } from "../../../app/native-editor-locality.runtime.ts";
import { McpAppCatalog } from "../../../components/mcp-app-catalog.tsx";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { Menu, type MenuEntry, type MenuHandle } from "../../../components/solid/menu.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import "../../../components/tooltip.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerCodeBlocksEnglish } from "../../../i18n/locales/en-code-blocks.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { EDITOR_IDS, EDITOR_LABELS } from "../../../lib/editor-links.ts";
import "../../../styles/session-panel-rail.css";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { FileCopyAction } from "./chat-file-copy.ts";
import { FileDownloadButton } from "./chat-file-download-button.tsx";
import type { FileReaderChromeProps, FileViewControls } from "./chat-file-reader-controls.ts";
import { WorkspaceBreadcrumb } from "./chat-session-workspace-breadcrumb.tsx";
import type { FileReaderWorkspace } from "./chat-sidebar-view-types.ts";

registerEnglishCatalog(registerChatSessionEnglish);

registerCodeBlocksEnglish();
registerFilePreviewEnglish();

export function DesktopFileNavigation(props: {
  name: string;
  path: string;
  workspace?: FileReaderWorkspace;
}) {
  const treeMotion = (event: MouseEvent) => {
    const reader =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget.closest<HTMLElement>(".chat-files-panel__content")
        : null;
    if (reader) {
      reader.dataset.treeMotion = event.detail === 0 ? "instant" : "animated";
    }
  };
  return (
    <Show
      when={props.workspace}
      fallback={
        <span
          ref={createTextOverflow(() => props.path)}
          class="sidebar-file-view__path"
          title={props.path}
        >
          {props.path || props.name}
        </span>
      }
    >
      {(workspace) => (
        <>
          <div class="session-panel-rail__group">
            <FileAction
              label={t("chat.detailPanel.toggleTree")}
              icon="panelLeft"
              pressed={workspace().catalog.navigation?.treeVisible === true}
              onClick={(event) => {
                treeMotion(event);
                workspace().catalog.onTreeVisibleChange?.(
                  !workspace().catalog.navigation?.treeVisible,
                );
              }}
            />
            <Show when={!workspace().catalog.navigation?.treeVisible}>
              <FileAction
                label={t("chat.workspaceFiles.search")}
                icon="search"
                onClick={(event) => {
                  treeMotion(event);
                  workspace().catalog.onSearchOpenChange?.(true);
                }}
              />
            </Show>
          </div>
          <WorkspaceBreadcrumb
            path={workspace().path}
            rootLabel={workspace().rootLabel}
            sourceLabel={workspace().sourceLabel}
            name={props.name}
            onBrowsePath={(path) => workspace().onBrowsePath(path)}
          />
        </>
      )}
    </Show>
  );
}

export function DesktopFileChrome(props: FileReaderChromeProps) {
  const id = createUniqueId();
  const searchMenus: Partial<Record<"wide" | "compact", MenuHandle>> = {};
  // Resolve on Escape: container layout can change while Find is open.
  const searchTrigger = () =>
    Object.values(searchMenus)
      .map((handle) => handle.overlay.trigger)
      .find(
        (trigger): trigger is HTMLButtonElement =>
          trigger instanceof HTMLButtonElement &&
          trigger.checkVisibility({ checkVisibilityCSS: true }),
      );
  const mode = () => props.controls.readingMode ?? "highlighted";
  const modeEntries = (): MenuEntry[] =>
    (props.controls.markdown || props.controls.imagePreview
      ? (["preview", "highlighted", "plain"] as const)
      : (["highlighted", "plain"] as const)
    ).map((value) => ({
      id: value,
      label: t(
        `chat.detailPanel.${value === "preview" ? "preview" : value === "highlighted" ? "highlightedSource" : "plainSource"}`,
      ),
      icon: (
        <Icon
          name={value === "preview" ? "eye" : value === "highlighted" ? "codeXml" : "fileText"}
        />
      ),
      type: "radio",
      checked: mode() === value,
      disabled: props.controls.editing,
    }));
  const actions = (compact: boolean): MenuEntry[] => [
    ...(props.controls.fileAttachment
      ? [
          {
            id: "attach-session",
            label: t("chat.detailPanel.attachToSession"),
            icon: <Icon name="paperclip" />,
            disabled: props.controls.fileAttachment.disabled,
          },
        ]
      : []),
    ...(compact && props.controls.htmlPreview
      ? [
          {
            id: "html-mode",
            label: t(
              props.controls.htmlPreview.source
                ? "chat.detailPanel.preview"
                : "chat.detailPanel.viewSource",
            ),
            icon: <Icon name={props.controls.htmlPreview.source ? "eye" : "codeXml"} />,
          },
        ]
      : []),
    ...(compact && !props.controls.htmlPreview
      ? props.controls.markdown || props.controls.imagePreview
        ? modeEntries()
        : [
            {
              id: "highlight",
              label: t("chat.detailPanel.syntaxHighlighting"),
              icon: <Icon name="codeXml" />,
              type: "checkbox" as const,
              checked: mode() === "highlighted",
              disabled: props.controls.editing,
            },
          ]
      : []),
    ...(compact
      ? [
          {
            id: "wrap",
            label: t("chat.detailPanel.wrapLines"),
            icon: <Icon name="wrapText" />,
            type: "checkbox" as const,
            checked: props.controls.wrap,
            disabled:
              mode() === "preview" ||
              Boolean(props.controls.htmlPreview && !props.controls.htmlPreview.source),
          },
        ]
      : []),
    ...(compact && props.content.edit && !props.controls.editing
      ? [
          {
            id: "edit",
            label: t("chat.detailPanel.editFile"),
            icon: <Icon name="pencilLine" />,
            disabled: props.controls.loadingEditor,
          },
        ]
      : []),
    { id: "find", label: t("chat.detailPanel.searchInFile"), icon: <Icon name="search" /> },
    ...(props.content.path
      ? [
          {
            id: "path",
            label: t(
              props.controls.copyFeedback.path === "failed"
                ? "common.copyFailed"
                : props.controls.copyFeedback.path === "copied"
                  ? "common.copied"
                  : "chat.detailPanel.copyPath",
            ),
            icon: <Icon name={props.controls.copyFeedback.path === "copied" ? "check" : "copy"} />,
          },
        ]
      : []),
    ...(props.content.path && props.controls.onReveal
      ? [{ id: "reveal", label: t("chat.detailPanel.showInFiles"), icon: <Icon name="folder" /> }]
      : []),
    ...(localEditorFilePath(props.content, props.controls.execNode)
      ? [
          {
            id: "editor",
            label: t("chat.detailPanel.openInEditor"),
            icon: <Icon name="externalLink" />,
            children: EDITOR_IDS.map((editor) => ({
              id: `editor:${editor}`,
              label: EDITOR_LABELS[editor],
              icon: <Icon name="externalLink" />,
            })),
          },
        ]
      : []),
  ];
  const select = (value: string) => {
    if (value === "attach-session") {
      props.controls.fileAttachment?.attach();
    } else if (value === "html-mode") {
      props.controls.htmlPreview?.onToggle();
    } else if (value === "preview" || value === "highlighted" || value === "plain") {
      props.controls.onReadingModeChange?.(value);
    } else if (value === "highlight") {
      props.controls.onReadingModeChange?.(mode() === "highlighted" ? "plain" : "highlighted");
    } else if (value === "wrap") {
      props.controls.onToggleWrap();
    } else if (value === "edit") {
      props.controls.onEdit();
    } else if (value === "find") {
      props.controls.searchToggleRef?.(searchTrigger);
      props.controls.onToggleSearch();
    } else if (value === "path") {
      props.controls.onCopy("path");
    } else if (value === "reveal") {
      props.controls.onReveal?.(props.content.path);
    } else {
      const editor = EDITOR_IDS.find((candidate) => value === `editor:${candidate}`);
      if (editor) {
        props.controls.onOpenEditor(editor);
      }
    }
  };
  return (
    <div class="sidebar-file-view__path-bar session-panel-rail" data-presentation="desktop">
      <div class="sidebar-file-view__path-field">
        <DesktopFileNavigation
          name={props.content.name}
          path={props.content.path}
          workspace={props.controls.workspace}
        />
        <Show when={props.content.path}>
          <McpAppCatalog
            surface="file"
            sessionKey={props.runtime?.sessionKey ?? props.content.draftContext?.sessionKey ?? ""}
            agentId={props.runtime?.agentId ?? ""}
            filePath={props.content.path}
          />
        </Show>
      </div>
      <div class="sidebar-file-view__actions session-panel-rail__actions">
        <div class="session-panel-rail__group sidebar-file-view__reading-controls">
          <Show
            when={props.controls.htmlPreview}
            fallback={
              <Show
                when={props.controls.markdown || props.controls.imagePreview}
                fallback={
                  <FileAction
                    label={t("chat.detailPanel.syntaxHighlighting")}
                    icon="codeXml"
                    pressed={mode() === "highlighted"}
                    accent={!props.controls.editing ? mode() !== "highlighted" : undefined}
                    disabled={props.controls.editing}
                    onClick={() => select("highlight")}
                  />
                }
              >
                <Menu
                  id={`file-mode-${id}`}
                  panelClass="sidebar-file-view__menu"
                  label={`${t("chat.detailPanel.readingMode")}: ${t(`chat.detailPanel.${mode() === "preview" ? "preview" : mode() === "highlighted" ? "highlightedSource" : "plainSource"}`)}`}
                  trigger={
                    <>
                      <Icon
                        name={
                          mode() === "preview"
                            ? "eye"
                            : mode() === "highlighted"
                              ? "codeXml"
                              : "fileText"
                        }
                      />
                      <Icon name="chevronDown" class="session-panel-rail__chevron" />
                    </>
                  }
                  triggerClass="sidebar-file-view__mode session-panel-rail__button session-panel-rail__button--labelled"
                  disabled={props.controls.editing}
                  items={modeEntries()}
                  onSelect={(item) => select(item.id)}
                />
              </Show>
            }
          >
            {(preview) => (
              <FileAction
                label={t(
                  preview().source ? "chat.detailPanel.preview" : "chat.detailPanel.viewSource",
                )}
                icon={preview().source ? "eye" : "codeXml"}
                onClick={() => preview().onToggle()}
              />
            )}
          </Show>
          <Show when={props.controls.markdown || props.controls.imagePreview}>
            <span class="session-panel-rail__separator" aria-hidden="true" />
          </Show>
          <FileAction
            label={t(
              props.controls.wrap ? "chat.codeBlock.disableWrap" : "chat.codeBlock.enableWrap",
            )}
            icon="wrapText"
            pressed={props.controls.wrap}
            accent={
              !props.controls.editing &&
              !props.controls.markdown &&
              !props.controls.htmlPreview &&
              !props.controls.imagePreview
                ? !props.controls.wrap
                : undefined
            }
            disabled={
              mode() === "preview" ||
              Boolean(props.controls.htmlPreview && !props.controls.htmlPreview.source)
            }
            onClick={() => props.controls.onToggleWrap()}
          />
        </div>
        <Show when={props.controls.editing}>
          <div class="session-panel-rail__group sidebar-file-view__edit-actions">
            <FileTextAction
              label={t("chat.detailPanel.discard")}
              onClick={() => props.controls.onDiscard()}
              disabled={props.controls.saving}
            />
            <FileTextAction
              label={t(props.controls.saving ? "common.saving" : "common.save")}
              onClick={() => props.controls.onSave()}
              disabled={!props.controls.dirty || props.controls.saving}
            />
          </div>
        </Show>
        <div class="session-panel-rail__group sidebar-file-view__management">
          <Show when={!props.controls.editing && props.content.edit}>
            <span class="sidebar-file-view__wide-action">
              <FileAction
                label={t("chat.detailPanel.editFile")}
                icon="pencilLine"
                onClick={() => props.controls.onEdit()}
                disabled={props.controls.loadingEditor && !props.controls.markdown}
              />
            </span>
          </Show>
          <Show when={props.content.download}>
            {(download) => (
              <FileDownloadButton
                scopeKey={[
                  props.content.sessionFileSource?.sessionKey ?? props.runtime?.sessionKey,
                  props.content.artifactId ?? props.content.path,
                  props.content.sessionFileSource?.messageEntryId,
                  props.runtime?.connectionEpoch,
                ].join("\0")}
                download={(signal) => download()(signal)}
                class="session-panel-rail__button sidebar-file-view__action"
              />
            )}
          </Show>
          <Show when={props.content.download || (!props.controls.editing && props.content.edit)}>
            <span
              class={[
                "session-panel-rail__separator",
                { "sidebar-file-view__wide-action": !props.content.download },
              ]}
              aria-hidden="true"
            />
          </Show>
          <span class="sidebar-file-view__wide-action">
            <Menu
              id={`file-actions-${id}`}
              panelClass="sidebar-file-view__menu"
              ref={(menu) => {
                searchMenus.wide = menu;
              }}
              label={t("chat.detailPanel.fileActions")}
              trigger={<Icon name="moreHorizontal" />}
              triggerClass="session-panel-rail__button sidebar-file-view__action"
              items={actions(false)}
              onSelect={(item) => select(item.id)}
            />
          </span>
          <span class="sidebar-file-view__compact-action">
            <Menu
              id={`file-overflow-${id}`}
              panelClass="sidebar-file-view__menu"
              ref={(menu) => {
                searchMenus.compact = menu;
              }}
              label={t("chat.detailPanel.moreFileActions")}
              trigger={<Icon name="moreHorizontal" />}
              triggerClass="session-panel-rail__button sidebar-file-view__action"
              items={actions(true)}
              onSelect={(item) => select(item.id)}
            />
          </span>
        </div>
      </div>
    </div>
  );
}

export function FileAction(props: {
  label: string;
  icon: IconName;
  onClick: (event: MouseEvent) => void;
  class?: string;
  pressed?: boolean;
  accent?: boolean;
  tooltip?: boolean;
  ref?: (element: HTMLButtonElement) => void;
  disabled?: boolean;
}) {
  return (
    <openclaw-tooltip prop:content={props.tooltip === false ? "" : props.label}>
      <button
        class={["btn btn--sm sidebar-file-view__action session-panel-rail__button", props.class]}
        data-accent={props.accent === undefined ? undefined : String(props.accent)}
        type="button"
        ref={props.ref}
        aria-label={props.label}
        aria-pressed={props.pressed === undefined ? undefined : props.pressed ? "true" : "false"}
        disabled={props.disabled}
        onClick={(event) => props.onClick(event)}
      >
        <Icon name={props.icon} />
      </button>
    </openclaw-tooltip>
  );
}

export function FileCopyButton(props: { action: FileCopyAction; controls?: FileViewControls }) {
  const feedback = () => props.controls?.copyFeedback[props.action];
  return (
    <FileAction
      label={t(
        feedback() === "failed"
          ? "common.copyFailed"
          : feedback() === "copied"
            ? "common.copied"
            : props.action === "path"
              ? "chat.detailPanel.copyPath"
              : "chat.detailPanel.copyContents",
      )}
      icon={feedback() === "copied" ? "check" : "copy"}
      onClick={() => props.controls?.onCopy(props.action)}
      class={feedback() === "copied" ? "copied" : ""}
    />
  );
}

export function FileTextAction(props: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      class="btn btn--sm"
      type="button"
      disabled={props.disabled}
      onClick={() => props.onClick()}
    >
      {props.label}
    </button>
  );
}
