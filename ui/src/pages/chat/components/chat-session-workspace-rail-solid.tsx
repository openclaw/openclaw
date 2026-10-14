import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { shortestFileLabels } from "../../../components/file-kind.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import "../../../components/tooltip.ts";
import { formatByteSize } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { liveValue } from "../../../lib/reactive/live-value.ts";
import { isSessionWorkspaceFileSelected } from "../../../lib/sessions/workspace.ts";
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
  return typeof size !== "number" || !Number.isFinite(size) || size < 0
    ? ""
    : formatByteSize(size, {
        style: "legacy-binary",
        maxUnit: "mega",
        separator: " ",
        fractionDigits: (value, unit) =>
          unit === "byte" ? null : Math.round(value * 10) % 10 ? 1 : 0,
      });
}

function RailRow(props: {
  icon: IconName;
  name: string;
  meta?: string;
  tooltip?: string;
  badge?: string;
  kindBadge?: boolean;
  onOpen: () => void;
  active?: boolean;
  directory?: boolean;
  path?: string;
  hideActions?: boolean;
}) {
  return (
    <div
      class={[
        "chat-workspace-rail__file",
        {
          "chat-workspace-rail__file--directory": props.directory,
          "chat-workspace-rail__file--active": props.active,
        },
      ]}
      role="listitem"
    >
      <button
        class="chat-workspace-rail__file-open"
        type="button"
        aria-label={props.tooltip ?? props.name}
        onClick={() => props.onOpen()}
      >
        <span class="chat-workspace-rail__file-icon">
          <Icon name={props.icon} />
        </span>
        <span class="chat-workspace-rail__file-main">
          <openclaw-tooltip prop:content={props.tooltip ?? props.name}>
            <span class="chat-workspace-rail__file-name">{props.name}</span>
          </openclaw-tooltip>
          <Show when={props.meta}>
            <span class="chat-workspace-rail__file-meta">{props.meta}</span>
          </Show>
        </span>
      </button>
      <Show when={props.badge}>
        <span
          class={[
            "chat-workspace-rail__file-badge",
            { "chat-workspace-rail__file-badge--kind": props.kindBadge },
          ]}
        >
          {props.badge}
        </span>
      </Show>
      <Show when={!props.hideActions}>
        <span
          class="chat-workspace-rail__row-actions"
          role="group"
          aria-label={t("chat.workspaceFiles.actions")}
        >
          <openclaw-tooltip prop:content={t("chat.workspaceFiles.preview")}>
            <button
              class="chat-workspace-rail__row-action"
              type="button"
              aria-label={t("chat.workspaceFiles.preview")}
              ref={(button) =>
                button.addEventListener("click", (event) => {
                  event.stopPropagation();
                  props.onOpen();
                })
              }
            >
              <Icon name="eye" />
            </button>
          </openclaw-tooltip>
          <Show when={props.path !== undefined}>
            <span
              ref={(element) =>
                element.addEventListener("click", (event) => event.stopPropagation())
              }
            >
              <CopyButton text={props.path ?? ""} idleLabel={t("chat.workspaceFiles.copyPath")} />
            </span>
          </Show>
        </span>
      </Show>
    </div>
  );
}

function WorkspaceGroup(props: {
  title: string;
  count: number;
  defaultOpen?: boolean;
  forcedOpen: boolean;
  children: JSX.Element;
}) {
  // The mode is the identity: native toggles survive refresh, but search/filter changes reopen groups.
  return (
    <For each={[props.forcedOpen]}>
      {(forcedOpen) => (
        <details class="chat-workspace-rail__group" open={props.defaultOpen || forcedOpen}>
          <summary class="chat-workspace-rail__group-summary">
            <span class="chat-workspace-rail__group-chevron" aria-hidden="true">
              <Icon name="chevronRight" />
            </span>
            {props.title}
            <span class="chat-workspace-rail__group-count">{props.count}</span>
          </summary>
          {props.children}
        </details>
      )}
    </For>
  );
}

function WorkspaceContents(props: { workspace: SessionWorkspaceProps }) {
  const data = createMemo(() => {
    const workspace = props.workspace;
    const files = workspace.list?.files ?? [];
    const artifacts = workspace.list?.artifacts ?? [];
    const browser = workspace.list?.browser;
    const entries = browser?.entries ?? [];
    const search = normalizeOptionalString(workspace.browserSearch)?.toLowerCase() ?? "";
    const matches = (...values: (string | undefined)[]) =>
      values.some((value) => value?.toLowerCase().includes(search));
    const modified = files.filter((file) => file.kind === "modified");
    const read = files.filter((file) => file.kind === "read");
    const filters = [
      {
        filter: "all",
        label: t("chat.workspaceFiles.filterAll"),
        count: files.length + artifacts.length,
      },
      {
        filter: "changed",
        label: t("chat.workspaceFiles.changedCount", { count: String(modified.length) }),
        count: modified.length,
      },
      {
        filter: "read",
        label: t("chat.workspaceFiles.readCount", { count: String(read.length) }),
        count: read.length,
      },
      {
        filter: "artifacts",
        label: t("chat.workspaceFiles.artifactCount", { count: String(artifacts.length) }),
        count: artifacts.length,
      },
    ] satisfies { filter: SessionWorkspaceFilter; label: string; count: number }[];
    // A vanished chip falls back to All, retaining a visible reset path.
    const activeFilter = filters.some(
      ({ filter, count }) => filter === workspace.filter && count > 0,
    )
      ? workspace.filter
      : "all";
    const unavailableFolder =
      !browser &&
      workspace.list !== null &&
      !workspace.loading &&
      !search &&
      workspace.browserPath !== "";
    const parentPath = unavailableFolder
      ? workspace.browserPath.slice(0, Math.max(0, workspace.browserPath.lastIndexOf("/")))
      : !browser?.search
        ? browser?.parentPath
        : null;
    return {
      fileLabels: shortestFileLabels(files.map((file) => file.path || file.name)),
      changed: modified.filter((file) => matches(file.path, file.name)),
      read: read.filter((file) => matches(file.path, file.name)),
      artifacts: artifacts.filter((artifact) =>
        matches(artifact.title, artifact.id, artifact.mimeType),
      ),
      entries,
      browser,
      search,
      filters,
      activeFilter,
      unavailableFolder,
      parentPath,
      hasItems: files.length > 0 || artifacts.length > 0 || entries.length > 0,
      forcedOpen: Boolean(search) || activeFilter !== "all",
    };
  });
  const visible = (filter: SessionWorkspaceFilter | null) =>
    data().activeFilter === "all" || data().activeFilter === filter;
  const browserVisible = () => visible(null) && Boolean(data().browser || data().unavailableFolder);
  const hasGroups = () =>
    (visible("changed") && data().changed.length > 0) ||
    (visible("read") && data().read.length > 0) ||
    (visible("artifacts") && data().artifacts.length > 0) ||
    browserVisible();
  const selected = (path: string, workspacePath?: string) =>
    isSessionWorkspaceFileSelected(
      props.workspace.activeId,
      props.workspace.sessionKey,
      props.workspace.list?.root,
      path,
      workspacePath,
    );
  const FileRows = (rowProps: { rows: NonNullable<SessionWorkspaceProps["list"]>["files"] }) => (
    <div class="chat-workspace-rail__list" role="list">
      <For each={rowProps.rows} keyed={(file) => file.path}>
        {(file) => (
          <RailRow
            icon="fileText"
            name={data().fileLabels.get(file().path || file().name) ?? file().name}
            tooltip={file().path || file().name}
            meta={formatWorkspaceFileSize(file().size)}
            active={selected(file().path, file().workspacePath)}
            badge={file().missing ? t("chat.workspaceFiles.missing") : undefined}
            onOpen={() => props.workspace.onOpenFile(file().path, "session")}
            path={file().path}
          />
        )}
      </For>
    </div>
  );
  return (
    <aside class="chat-workspace-rail" aria-label={t("chat.workspaceFiles.label")}>
      <Show when={props.workspace.list?.root}>
        <openclaw-tooltip prop:content={props.workspace.list?.root}>
          <div class="chat-workspace-rail__path">{props.workspace.list?.root}</div>
        </openclaw-tooltip>
      </Show>
      <div class="chat-workspace-rail__toolbar">
        <label class="chat-workspace-rail__search">
          <span class="chat-workspace-rail__search-icon" aria-hidden="true">
            <Icon name="search" />
          </span>
          <input
            type="search"
            placeholder={t("chat.workspaceFiles.search")}
            aria-label={t("chat.workspaceFiles.search")}
            ref={liveValue(() => props.workspace.browserSearch)}
            onInput={(event) => props.workspace.onSearch(event.currentTarget.value)}
          />
        </label>
        <Show when={data().filters[0]!.count > 0}>
          <div
            class="chat-workspace-rail__filters"
            role="group"
            aria-label={t("chat.workspaceFiles.filters")}
          >
            <For
              each={data().filters.filter(({ count }) => count > 0)}
              keyed={(filter) => filter.filter}
            >
              {(filter) => (
                <button
                  type="button"
                  class="chat-workspace-rail__chip"
                  aria-pressed={data().activeFilter === filter().filter ? "true" : "false"}
                  onClick={() => props.workspace.onSetFilter(filter().filter)}
                >
                  {filter().label}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
      <Show
        when={!props.workspace.error}
        fallback={
          <div class="chat-workspace-rail__state chat-workspace-rail__state--error">
            {props.workspace.error}
          </div>
        }
      >
        <Show
          when={!props.workspace.loading || data().hasItems}
          fallback={
            <PanelLoadingSkeleton variant="files" label={t("chat.workspaceFiles.loading")} />
          }
        >
          <div class="chat-workspace-rail__scroll">
            <Show when={visible("changed") && data().changed.length > 0}>
              <WorkspaceGroup
                title={t("chat.workspaceFiles.changed")}
                count={data().changed.length}
                defaultOpen
                forcedOpen={data().forcedOpen}
              >
                <FileRows rows={data().changed} />
              </WorkspaceGroup>
            </Show>
            <Show when={visible("read") && data().read.length > 0}>
              <WorkspaceGroup
                title={t("chat.workspaceFiles.read")}
                count={data().read.length}
                forcedOpen={data().forcedOpen}
              >
                <FileRows rows={data().read} />
              </WorkspaceGroup>
            </Show>
            <Show when={visible("artifacts") && data().artifacts.length > 0}>
              <WorkspaceGroup
                title={t("chat.workspaceFiles.artifacts")}
                count={data().artifacts.length}
                forcedOpen={data().forcedOpen}
              >
                <div class="chat-workspace-rail__list" role="list">
                  <For each={data().artifacts} keyed={(artifact) => artifact.id}>
                    {(artifact) => (
                      <RailRow
                        icon={artifact().mimeType?.startsWith("image/") ? "image" : "paperclip"}
                        name={artifact().title}
                        meta={[artifact().mimeType, formatWorkspaceFileSize(artifact().sizeBytes)]
                          .filter(Boolean)
                          .join(" / ")}
                        active={`artifact:${artifact().id}` === props.workspace.activeId}
                        onOpen={() => props.workspace.onOpenArtifact(artifact().id)}
                      />
                    )}
                  </For>
                </div>
              </WorkspaceGroup>
            </Show>
            <Show when={browserVisible()}>
              <WorkspaceGroup
                title={t("chat.workspaceFiles.browser")}
                count={data().entries.length}
                defaultOpen
                forcedOpen={data().forcedOpen}
              >
                <Show when={data().browser?.search}>
                  <div class="chat-workspace-rail__browser-caption">
                    {t("chat.workspaceFiles.searchResults")}
                  </div>
                </Show>
                <div
                  class="chat-workspace-rail__list chat-workspace-rail__list--browser"
                  role="list"
                >
                  <Show when={data().parentPath != null}>
                    <RailRow
                      icon="folder"
                      name=".."
                      directory
                      hideActions
                      meta={t("chat.workspaceFiles.parentFolder")}
                      onOpen={() => props.workspace.onBrowsePath(data().parentPath ?? "")}
                    />
                  </Show>
                  <Show when={data().entries.length === 0}>
                    <div class="chat-workspace-rail__state">
                      {t(
                        data().unavailableFolder
                          ? "chat.workspaceFiles.folderUnavailable"
                          : data().browser?.search
                            ? "chat.workspaceFiles.noSearchResults"
                            : "chat.workspaceFiles.noBrowserFiles",
                      )}
                    </div>
                  </Show>
                  <For each={data().entries} keyed={(entry) => entry.path}>
                    {(entry) => {
                      const directory = () => entry().kind === "directory";
                      const onOpen = () =>
                        directory()
                          ? props.workspace.onBrowsePath(entry().path)
                          : props.workspace.onOpenFile(entry().path, "workspace");
                      return (
                        <RailRow
                          icon={directory() ? "folder" : "fileText"}
                          name={entry().name}
                          tooltip={entry().path || entry().name}
                          meta={
                            directory()
                              ? entry().path || t("chat.workspaceFiles.root")
                              : [entry().path, formatWorkspaceFileSize(entry().size)]
                                  .filter(Boolean)
                                  .join(" / ")
                          }
                          directory={directory()}
                          active={selected(entry().path, entry().path)}
                          badge={
                            entry().sessionKind
                              ? t(SESSION_KIND_LABELS[entry().sessionKind!])
                              : undefined
                          }
                          kindBadge
                          onOpen={onOpen}
                          path={entry().path}
                          hideActions={directory()}
                        />
                      );
                    }}
                  </For>
                </div>
                <Show when={data().browser?.truncated}>
                  <div class="chat-workspace-rail__state">{t("chat.workspaceFiles.truncated")}</div>
                </Show>
              </WorkspaceGroup>
            </Show>
            <Show
              when={
                data().search &&
                props.workspace.list !== null &&
                !props.workspace.loading &&
                !hasGroups()
              }
            >
              <div class="chat-workspace-rail__state" role="status">
                {t("chat.workspaceFiles.noSearchResults")}
              </div>
            </Show>
          </div>
        </Show>
      </Show>
    </aside>
  );
}

export function SessionWorkspaceRail(props: { workspace?: SessionWorkspaceProps }) {
  return (
    <Show when={props.workspace}>
      {(workspace) => <WorkspaceContents workspace={workspace()} />}
    </Show>
  );
}
