import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import { fileKindForPath } from "../../../components/file-kind.ts";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { formatByteSize } from "../../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { liveValue } from "../../../lib/reactive/live-value.ts";
import { createScrollPosition } from "../../../lib/reactive/scroll-state.ts";
import type { SessionWorkspaceFilter } from "./chat-sidebar-content-types.ts";
import "./chat-session-workspace-mobile.css";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";

registerEnglishCatalog(registerChatSessionEnglish);

type SessionFile = SessionWorkspaceListResult["files"][number];
type Artifact = NonNullable<SessionWorkspaceListResult["artifacts"]>[number];
type BrowserEntry = NonNullable<SessionWorkspaceListResult["browser"]>["entries"][number];

/** Already filtered by the workspace owner; this view does not search or sort another catalog. */
export type SessionWorkspaceMobileGroup = { expanded: boolean } & (
  | { kind: "changed" | "read"; files: readonly SessionFile[] }
  | { kind: "artifacts"; artifacts: readonly Artifact[] }
  | { kind: "workspace"; entries: readonly BrowserEntry[]; truncated: boolean }
);

export type SessionWorkspaceMobileLocation =
  | { kind: "root" }
  | {
      kind: "folder";
      /** Includes the workspace root; paths are owner-issued navigation targets. */
      breadcrumbs: readonly { path: string; label: string }[];
      backLabel: string;
      searchLabel: string;
      onBack: () => void;
    };

export type SessionWorkspaceMobileStatus =
  | { kind: "ready"; refreshing: boolean }
  | { kind: "loading" }
  | { kind: "empty"; heading: string; description: string }
  | { kind: "error" | "unavailable"; message: string; onRetry?: () => void };

export type SessionWorkspaceMobileProps = {
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
  /** Native transcript source, supplied by the workspace adapter. */
  attachmentContent?: JSX.Element;
  groups: readonly SessionWorkspaceMobileGroup[];
  location: SessionWorkspaceMobileLocation;
  status: SessionWorkspaceMobileStatus;
  filter: SessionWorkspaceFilter;
  search: string;
  onSetFilter: SessionWorkspaceProps["onSetFilter"];
  onSearch: SessionWorkspaceProps["onSearch"];
  onBrowsePath: SessionWorkspaceProps["onBrowsePath"];
  /** Must enter the existing Files route, not select an independent hosted tab. */
  onOpenFileInsideFiles: SessionWorkspaceProps["onOpenFile"];
  onOpenArtifactInsideFiles: SessionWorkspaceProps["onOpenArtifact"];
  onToggleGroup: (kind: SessionWorkspaceMobileGroup["kind"]) => void;
  /** The mobile host expands on editable focus; blur does not minimize it. */
  onSearchFocus: () => void;
  /** Host owns route scroll restoration and retention, including while hidden. */
  onScrollElement: (element: HTMLDivElement | null) => void;
  onScroll: (scrollTop: number) => void;
};

const FILTERS = ["all", "changed", "read", "artifacts"] as const;
const GROUP_LABELS = {
  changed: "chat.workspaceFiles.changed",
  read: "chat.workspaceFiles.read",
  artifacts: "chat.workspaceFiles.desktop.sessionFiles",
  workspace: "chat.workspaceFiles.files",
} as const;

function groupCount(group: SessionWorkspaceMobileGroup): number {
  if (group.kind === "workspace") {
    return group.entries.length;
  }
  if (group.kind === "artifacts") {
    return group.artifacts.length;
  }
  return group.files.length;
}

function parentDirectory(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator < 0 ? "" : path.slice(0, separator);
}

function fileIcon(path: string): IconName {
  const kind = fileKindForPath(path);
  return kind === "image"
    ? "image"
    : kind === "code" || kind === "component"
      ? "fileCode"
      : "fileText";
}

function MobileFileName(props: { name: string; directory?: boolean }) {
  const split = createMemo(() => {
    const dot = props.directory ? -1 : props.name.lastIndexOf(".");
    return dot > 0 && dot < props.name.length - 1
      ? [props.name.slice(0, dot), props.name.slice(dot)]
      : [props.name, ""];
  });
  return (
    <span class="chat-workspace-mobile__name">
      <span class="chat-workspace-mobile__stem">{split()[0]}</span>
      <span class="chat-workspace-mobile__extension">{split()[1]}</span>
    </span>
  );
}

function MobileFileRow(props: {
  name: string;
  path: string;
  directory?: boolean;
  parent?: string;
  size?: number;
  missing?: boolean;
  icon: IconName;
  onOpen: () => void;
}) {
  return (
    <li class="chat-workspace-mobile__item">
      <button
        type="button"
        class="chat-workspace-mobile__row"
        aria-label={props.path || props.name}
        onClick={() => props.onOpen()}
      >
        <Icon name={props.icon} class="chat-workspace-mobile__file-icon" />
        <span class="chat-workspace-mobile__identity">
          <MobileFileName name={props.name} directory={props.directory} />
          <Show when={props.parent}>
            <span class="chat-workspace-mobile__directory">{props.parent}</span>
          </Show>
        </span>
        <Show when={props.missing}>
          <span class="chat-workspace-mobile__meta">{t("chat.workspaceFiles.missing")}</span>
        </Show>
        <Show when={props.size !== undefined && !props.missing}>
          <span class="chat-workspace-mobile__meta">
            {formatByteSize(props.size ?? 0, {
              style: "legacy-binary",
              maxUnit: "mega",
              separator: " ",
              fractionDigits: (value, unit) =>
                unit === "byte" ? null : Math.round(value * 10) % 10 ? 1 : 0,
            })}
          </span>
        </Show>
        <Icon name="chevronRight" class="chat-workspace-mobile__chevron" />
      </button>
    </li>
  );
}

function MobileFolderHeader(props: {
  location: Extract<SessionWorkspaceMobileLocation, { kind: "folder" }>;
  onBrowsePath: SessionWorkspaceProps["onBrowsePath"];
}) {
  const [trail, setTrail] = createSignal<HTMLDivElement>();
  // Each folder destination reveals its current crumb without scrolling the outer host.
  createScrollPosition(() => ({
    restore: {
      identity: [trail(), props.location.breadcrumbs.at(-1)?.path],
      target: trail(),
      left: "end",
    },
  }));
  return (
    <div class="chat-workspace-mobile__folder-header">
      <button
        type="button"
        class="chat-workspace-mobile__back"
        aria-label={props.location.backLabel}
        onClick={() => props.location.onBack()}
      >
        <Icon name="chevronLeft" />
      </button>
      <div class="chat-workspace-mobile__breadcrumbs" ref={setTrail}>
        <For each={props.location.breadcrumbs} keyed={(crumb) => crumb.path}>
          {(crumb, index) => (
            <>
              <Show when={index() > 0}>
                <Icon name="chevronRight" />
              </Show>
              <button
                type="button"
                aria-current={
                  index() === props.location.breadcrumbs.length - 1 ? "location" : undefined
                }
                onClick={() => props.onBrowsePath(crumb().path)}
              >
                {crumb().label}
              </button>
            </>
          )}
        </For>
      </div>
    </div>
  );
}

function MobileGroupRows(props: {
  group: SessionWorkspaceMobileGroup;
  folder: boolean;
  search: string;
  onBrowsePath: SessionWorkspaceMobileProps["onBrowsePath"];
  onOpenFileInsideFiles: SessionWorkspaceMobileProps["onOpenFileInsideFiles"];
  onOpenArtifactInsideFiles: SessionWorkspaceMobileProps["onOpenArtifactInsideFiles"];
}) {
  const files = createMemo(() => {
    const group = props.group;
    return group.kind === "changed" || group.kind === "read" ? group.files : [];
  });
  const artifacts = createMemo(() => {
    const group = props.group;
    return group.kind === "artifacts" ? group.artifacts : [];
  });
  const workspace = createMemo(() => {
    const group = props.group;
    return group.kind === "workspace" ? group : undefined;
  });
  return (
    <>
      <ul class="chat-workspace-mobile__list">
        <For each={files()} keyed={(file) => file.path}>
          {(file) => (
            <MobileFileRow
              name={file().name}
              path={file().path}
              parent={parentDirectory(file().path)}
              missing={file().missing}
              icon={fileIcon(file().path)}
              onOpen={() => props.onOpenFileInsideFiles(file().path, "session")}
            />
          )}
        </For>
        <For each={artifacts()} keyed={(artifact) => artifact.id}>
          {(artifact) => (
            <MobileFileRow
              name={artifact().title}
              path={artifact().title}
              icon={artifact().mimeType?.startsWith("image/") ? "image" : "paperclip"}
              onOpen={() => props.onOpenArtifactInsideFiles(artifact().id)}
            />
          )}
        </For>
        <For each={workspace()?.entries} keyed={(entry) => entry.path}>
          {(entry) => (
            <MobileFileRow
              name={entry().name}
              path={entry().path}
              directory={entry().kind === "directory"}
              parent={props.search ? parentDirectory(entry().path) : undefined}
              size={props.folder && entry().kind === "file" ? entry().size : undefined}
              icon={entry().kind === "directory" ? "folder" : fileIcon(entry().path)}
              onOpen={() =>
                entry().kind === "directory"
                  ? props.onBrowsePath(entry().path)
                  : props.onOpenFileInsideFiles(entry().path, "workspace")
              }
            />
          )}
        </For>
      </ul>
      <Show when={workspace()?.truncated}>
        <p class="chat-workspace-mobile__notice" role="status">
          {t("chat.workspaceFiles.truncated")}
        </p>
      </Show>
    </>
  );
}

/** Controlled catalog only. The mobile host mounts the retained reader for a file destination. */
export function SessionWorkspaceMobile(props: SessionWorkspaceMobileProps) {
  let scroll!: HTMLDivElement;
  let content!: HTMLDivElement;
  const folder = () => props.location.kind === "folder";
  const busy = () =>
    props.status.kind === "loading" || (props.status.kind === "ready" && props.status.refreshing);
  const updateFades = () => {
    scroll.toggleAttribute("data-fade-top", scroll.scrollTop > 1);
    scroll.toggleAttribute(
      "data-fade-bottom",
      scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 1,
    );
  };
  onSettled(() => {
    props.onScrollElement(scroll);
    const releaseScrollPort = props.onScrollPortRef?.(scroll);
    const observer = new ResizeObserver(updateFades);
    observer.observe(scroll);
    observer.observe(content);
    updateFades();
    return () => {
      observer.disconnect();
      releaseScrollPort?.();
      props.onScrollElement(null);
    };
  });
  return (
    <section class="chat-workspace-mobile" aria-label={t("chat.workspaceFiles.label")}>
      <div class="chat-workspace-mobile__rail">
        <Show when={props.location.kind === "folder" && props.location}>
          {(location) => (
            <MobileFolderHeader location={location()} onBrowsePath={props.onBrowsePath} />
          )}
        </Show>
        <label class="chat-workspace-mobile__search">
          <Icon name="search" />
          <input
            type="search"
            placeholder={
              props.location.kind === "folder"
                ? props.location.searchLabel
                : t("chat.workspaceFiles.search")
            }
            aria-label={
              props.location.kind === "folder"
                ? props.location.searchLabel
                : t("chat.workspaceFiles.search")
            }
            ref={liveValue(() => props.search)}
            onInput={(event) => props.onSearch(event.currentTarget.value)}
            onFocus={() => props.onSearchFocus()}
          />
        </label>
      </div>
      <div
        class="chat-workspace-mobile__scroll"
        ref={(element) => {
          scroll = element;
        }}
        aria-busy={busy() ? "true" : "false"}
        onScroll={() => {
          updateFades();
          props.onScroll(scroll.scrollTop);
        }}
      >
        <div
          class="chat-workspace-mobile__content"
          ref={(element) => {
            content = element;
          }}
        >
          <Show when={!folder()}>
            <div
              class="chat-workspace-mobile__filters"
              role="group"
              aria-label={t("chat.workspaceFiles.filters")}
            >
              <For each={FILTERS}>
                {(filter) => (
                  <button
                    type="button"
                    aria-pressed={props.filter === filter ? "true" : "false"}
                    onClick={() => props.onSetFilter(filter)}
                  >
                    {t(
                      filter === "all"
                        ? "chat.workspaceFiles.filterAll"
                        : filter === "artifacts"
                          ? "chat.workspaceFiles.desktop.sessionFiles"
                          : `chat.workspaceFiles.${filter}`,
                    )}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={props.status.kind === "loading"}>
            <PanelLoadingSkeleton variant="files" label={t("chat.workspaceFiles.loading")} />
          </Show>
          <Show
            when={
              (props.status.kind === "error" || props.status.kind === "unavailable") && props.status
            }
          >
            {(status) => (
              <div
                class="chat-workspace-mobile__state"
                role={status().kind === "error" ? "alert" : "status"}
              >
                <p>{status().message}</p>
                <Show when={status().onRetry}>
                  {(retry) => (
                    <button type="button" class="btn" onClick={() => retry()()}>
                      {t("common.retry")}
                    </button>
                  )}
                </Show>
              </div>
            )}
          </Show>
          <Show when={props.status.kind === "empty" && props.status}>
            {(status) => (
              <PanelEmptyState
                heading={status().heading}
                description={status().description}
                icon={<Icon name="folder" />}
              />
            )}
          </Show>
          <Show when={props.status.kind === "ready"}>
            <For each={props.groups} keyed={(group) => group.kind}>
              {(group) => (
                <div class="chat-workspace-mobile__group">
                  <Show when={!folder()}>
                    <button
                      type="button"
                      class="chat-workspace-mobile__group-heading"
                      aria-expanded={group().expanded ? "true" : "false"}
                      onClick={() => props.onToggleGroup(group().kind)}
                    >
                      <Icon name={group().expanded ? "chevronDown" : "chevronRight"} />
                      {t(GROUP_LABELS[group().kind])}
                      <span class="chat-workspace-mobile__group-count">{groupCount(group())}</span>
                    </button>
                  </Show>
                  <Show when={folder() || group().expanded}>
                    <MobileGroupRows
                      group={group()}
                      folder={folder()}
                      search={props.search}
                      onBrowsePath={props.onBrowsePath}
                      onOpenFileInsideFiles={props.onOpenFileInsideFiles}
                      onOpenArtifactInsideFiles={props.onOpenArtifactInsideFiles}
                    />
                  </Show>
                </div>
              )}
            </For>
          </Show>
          {props.attachmentContent}
        </div>
      </div>
    </section>
  );
}
