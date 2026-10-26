import { createMemo, createSignal, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { StrokeIcon } from "../../../components/solid/stroke-icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import { isSessionWorkspaceFileSelected } from "../../../lib/sessions/workspace.ts";
import { AttachmentFileIcon } from "./chat-attachment-file-icon-solid.tsx";
import {
  splitWorkspaceFilename,
  type WorkspaceCatalogFile,
} from "./chat-session-workspace-catalog.ts";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";

export function WorkspaceFilename(props: { name: string }) {
  const parts = createMemo(() => splitWorkspaceFilename(props.name));
  const [overflow, setOverflow] = createSignal(false);
  let stem: HTMLSpanElement | undefined;
  createLayoutMeasurement(
    () => props.name,
    () => {
      const overflowing = Boolean(stem && stem.scrollWidth > stem.clientWidth);
      return () => setOverflow(overflowing);
    },
    { targets: () => (stem ? [stem] : []), fonts: true },
  );
  return (
    <span class="workspace-desktop__filename">
      <span
        ref={(element) => {
          stem = element;
        }}
        class={["workspace-desktop__stem", { "is-overflowed": overflow() }]}
      >
        {parts().stem}
      </span>
      <span>{parts().extension}</span>
    </span>
  );
}

export function RailRow(props: {
  file: WorkspaceCatalogFile;
  workspace: SessionWorkspaceProps;
  depth?: number;
  directory?: boolean;
  expanded?: boolean;
  searching?: boolean;
  onToggle?: (instant: boolean) => void;
}) {
  const selected = createMemo(() =>
    props.file.artifactId ||
    (props.file.origin === "session" && props.file.workspacePath === undefined)
      ? props.workspace.activeId === props.file.key
      : isSessionWorkspaceFileSelected(
          props.workspace.activeId,
          props.workspace.sessionKey,
          props.workspace.list?.root,
          props.file.path,
          props.file.workspacePath,
        ),
  );
  const onOpen = (disposition: "preview" | "pinned" = "preview") => {
    if (props.file.artifactId) {
      props.workspace.onOpenArtifact(props.file.artifactId, disposition);
    } else {
      props.workspace.onOpenFile(props.file.path, props.file.origin, disposition);
    }
  };
  const activity = () =>
    props.file.activity === "modified" || props.file.activity === "mixed"
      ? t("chat.workspaceFiles.changed")
      : props.file.activity === "read"
        ? t("chat.workspaceFiles.read")
        : undefined;
  return (
    <div role="listitem" class="workspace-desktop__item">
      <button
        type="button"
        class={["workspace-desktop__row", { "is-active": selected() }]}
        style={{
          "padding-inline-start": `min(calc(8px + ${props.depth ?? 0} * var(--workspace-tree-step, 16px)), max(8px, calc(100% - 100px)))`,
        }}
        aria-label={props.file.path}
        aria-description={activity()}
        aria-current={selected() ? "true" : undefined}
        aria-expanded={props.directory ? (props.expanded ? "true" : "false") : undefined}
        onClick={(event) => {
          if (props.directory) {
            props.onToggle?.(event.detail === 0);
          } else {
            onOpen();
          }
        }}
        onDblClick={() => {
          if (!props.directory) {
            onOpen("pinned");
          }
        }}
      >
        <Show
          when={props.directory}
          fallback={
            <AttachmentFileIcon
              filename={props.file.name}
              mimeType={props.file.mimeType}
              mode="preview-with-favicon"
            />
          }
        >
          <span class="workspace-desktop__folder-icon">
            <Show when={props.expanded} fallback={<Icon name="folder" />}>
              {/* Lucide folder-open, the approved Files glyph (ISC). */}
              <StrokeIcon aria-hidden="true">
                <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
              </StrokeIcon>
            </Show>
          </span>
        </Show>
        <span class="workspace-desktop__identity">
          <span class="workspace-desktop__name-line">
            <WorkspaceFilename name={props.file.name} />
            <Show when={!props.directory && activity()}>
              <span
                class={[
                  "workspace-desktop__activity",
                  { "is-changed": props.file.activity !== "read" },
                ]}
                role="img"
                aria-label={activity()}
              />
            </Show>
          </span>
          <Show when={props.searching}>
            <span class="workspace-desktop__location">
              {props.file.artifactId
                ? t("chat.workspaceFiles.desktop.sessionFiles")
                : (props.file.workspacePath ?? props.file.path)}
            </span>
          </Show>
        </span>
      </button>
    </div>
  );
}
