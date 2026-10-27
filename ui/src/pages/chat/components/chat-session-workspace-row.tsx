import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualItem,
} from "@tanstack/virtual-core";
import {
  createMemo,
  createSignal,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { StrokeIcon } from "../../../components/solid/stroke-icon.tsx";
import { formatUiError } from "../../../lib/format-error.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import { isSessionWorkspaceFileSelected } from "../../../lib/sessions/workspace.ts";
import { AttachmentFileIcon } from "./chat-attachment-file-icon-solid.tsx";
import {
  splitWorkspaceFilename,
  type WorkspaceCatalogFile,
  type WorkspaceCatalogRow,
} from "./chat-session-workspace-catalog.ts";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";
import { FileDisclosure } from "./file-disclosure.tsx";

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
  position?: number;
  setSize?: number;
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
    <div
      role="listitem"
      class="workspace-desktop__item"
      aria-posinset={props.position}
      aria-setsize={props.setSize}
    >
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

export function WorkspaceRows(props: {
  rows: readonly WorkspaceCatalogRow[];
  workspace: SessionWorkspaceProps;
  childrenByPath: ReadonlyMap<string, readonly WorkspaceCatalogRow[]>;
  depth: number;
  viewport: HTMLElement | undefined;
  content: HTMLElement | undefined;
  active: boolean;
}) {
  let list: HTMLDivElement;
  const mountedRows = new Set<HTMLDivElement>();
  const [focusedKey, setFocusedKey] = createSignal<string>();
  const [window, setWindow] = createSignal<{ items: VirtualItem[]; height: number }>();
  const active = createMemo(() => props.active);
  // Keep a 250 -> 125 Changed filter windowed; small and mixed lists stay eager.
  const windowed = createMemo(
    () => props.rows.length >= 100 && props.rows.every((row) => !row.directory),
  );
  const rowIndexes = createMemo(
    () => new Map<VirtualItem["key"], number>(props.rows.map((row, index) => [row.key, index])),
  );
  const activeId = createMemo(() => props.workspace.activeId);
  const selectedKey = createMemo(
    () =>
      props.rows.find((row) =>
        isSessionWorkspaceFileSelected(
          activeId(),
          props.workspace.sessionKey,
          props.workspace.list?.root,
          row.path,
          row.workspacePath,
        ),
      )?.key,
  );
  const pinned = createMemo(() => {
    const focused = rowIndexes().get(focusedKey() ?? "");
    const selected = rowIndexes().get(selectedKey() ?? "");
    // Endpoints admit native Tab from either direction; neighbors let it keep
    // advancing without intercepting keys or creating a second focus owner.
    const indexes = [0, props.rows.length - 1, selected];
    if (focused !== undefined) {
      indexes.push(focused - 1, focused, focused + 1);
    }
    return indexes.filter(
      (index): index is number => index !== undefined && index >= 0 && index < props.rows.length,
    );
  });
  const publish = () => {
    if (!active() || !windowed()) {
      return;
    }
    const items = virtualizer.getVirtualItems();
    // A revealed scroller can still carry its last hidden (zero-height) rect
    // until ResizeObserver runs. Keep retained rows through that empty range.
    if (items.length) {
      setWindow({ items, height: virtualizer.getTotalSize() });
    }
  };
  const virtualizer = new Virtualizer<HTMLElement, HTMLDivElement>({
    count: 0,
    enabled: false,
    getScrollElement: () => props.viewport ?? null,
    initialOffset: () => props.viewport?.scrollTop ?? 0,
    estimateSize: () => 28,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    overscan: 4,
    useAnimationFrameWithResizeObserver: true,
    onChange: publish,
  });
  onSettled(() => {
    const { _didMount: mountVirtualizer } = virtualizer;
    return mountVirtualizer();
  });
  createLayoutMeasurement(
    () => ({
      rows: props.rows,
      indexes: rowIndexes(),
      pinned: pinned(),
      active: active(),
      windowed: windowed(),
    }),
    (next) => {
      const scroller = props.viewport;
      if (!next?.active || !scroller) {
        // Hidden rows report zero height; do not overwrite measured sizes.
        virtualizer.setOptions({ ...virtualizer.options, useCachedMeasurements: true });
        return;
      }
      // The virtualizer keeps removed keys; retain sizes only for current files.
      for (const key of virtualizer.itemSizeCache.keys()) {
        if (!next.indexes.has(key)) {
          virtualizer.itemSizeCache.delete(key);
        }
      }
      virtualizer.setOptions({
        ...virtualizer.options,
        count: next.rows.length,
        enabled: next.windowed,
        useCachedMeasurements: false,
        getItemKey: (index) => next.rows[index]!.key,
        scrollMargin:
          list.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop,
        rangeExtractor: (range) =>
          [...new Set([...defaultRangeExtractor(range), ...next.pinned])].toSorted((a, b) => a - b),
      });
      const { _willUpdate: updateVirtualizer } = virtualizer;
      updateVirtualizer();
      if (next.windowed) {
        for (const row of mountedRows) {
          virtualizer.measureElement(row);
        }
      }
      publish();
    },
    {
      targets: () => [
        list,
        ...(props.viewport ? [props.viewport] : []),
        ...(props.content ? [props.content] : []),
      ],
      changeTiming: "sync",
      fonts: true,
    },
  );
  const itemsByKey = createMemo(
    () => new Map(window()?.items.map((item) => [String(item.key), item])),
  );
  const renderedRows = createMemo(() => {
    if (!windowed()) {
      return props.rows;
    }
    const indexes = new Set(pinned());
    for (const key of itemsByKey().keys()) {
      const index = rowIndexes().get(key);
      if (index !== undefined) {
        indexes.add(index);
      }
    }
    return [...indexes].toSorted((a, b) => a - b).map((index) => props.rows[index]!);
  });
  function Row(rowProps: { row: WorkspaceCatalogRow }) {
    let element: HTMLDivElement;
    onSettled(() => {
      mountedRows.add(element);
      if (windowed()) {
        virtualizer.measureElement(element);
      }
      return () => {
        mountedRows.delete(element);
        virtualizer.measureElement(null);
      };
    });
    const index = () => rowIndexes().get(rowProps.row.key)!;
    const top = () => {
      const item = itemsByKey().get(rowProps.row.key);
      return item ? item.start - virtualizer.options.scrollMargin : index() * 28;
    };
    return (
      <div
        ref={(node) => (element = node)}
        data-index={index()}
        style={
          windowed()
            ? {
                position: "absolute",
                top: "0",
                left: "0",
                width: "100%",
                transform: `translateY(${top()}px)`,
              }
            : undefined
        }
        onFocusIn={() => setFocusedKey(rowProps.row.key)}
      >
        <DirectoryBranch
          row={rowProps.row}
          workspace={props.workspace}
          childrenByPath={props.childrenByPath}
          depth={props.depth}
          viewport={props.viewport}
          content={props.content}
          active={props.active}
          position={windowed() ? index() + 1 : undefined}
          setSize={windowed() ? props.rows.length : undefined}
        />
      </div>
    );
  }
  return (
    <div
      role="list"
      ref={(element) => (list = element)}
      style={
        windowed()
          ? { position: "relative", height: `${window()?.height ?? props.rows.length * 28}px` }
          : undefined
      }
    >
      <For each={renderedRows()} keyed={(row) => row.key}>
        {(row) => <Row row={row()} />}
      </For>
    </div>
  );
}

function DirectoryBranch(props: {
  row: WorkspaceCatalogRow;
  workspace: SessionWorkspaceProps;
  childrenByPath: ReadonlyMap<string, readonly WorkspaceCatalogRow[]>;
  depth: number;
  viewport: HTMLElement | undefined;
  content: HTMLElement | undefined;
  active: boolean;
  position?: number;
  setSize?: number;
}) {
  return (
    <div class="workspace-desktop__branch">
      <Show
        when={props.row.directory}
        fallback={
          <RailRow
            file={props.row}
            workspace={props.workspace}
            depth={props.depth}
            position={props.position}
            setSize={props.setSize}
          />
        }
      >
        {(isDirectory) => {
          const path = () => props.row.workspacePath ?? props.row.path;
          const expanded = createMemo(
            () => props.workspace.navigation?.expandedPaths.includes(path()) ?? false,
          );
          const active = createMemo(
            () =>
              props.workspace.navigation?.treeVisible !== false &&
              !props.workspace.navigation?.searchOpen,
          );
          const [instant, setInstant] = createSignal(true);
          const directory = createMemo(() => props.workspace.directories?.[path()]);
          const readResult = createMemo(
            () => ({ pending: props.workspace.directories?.[path()]?.readResult }),
            { equals: (previous, next) => previous.pending === next.pending },
          );
          const read = createMemo(async () => {
            const current = directory();
            const pending = readResult().pending;
            await pending;
            if (current?.error != null) {
              throw new Error(current.error || t("chat.workspaceFiles.folderUnavailable"));
            }
            return null;
          });
          const browser = () =>
            props.workspace.directories?.[path()]?.browser ??
            (!props.workspace.list?.browser?.search &&
            props.workspace.list?.browser?.path === path()
              ? props.workspace.list.browser
              : undefined);
          return (
            <>
              <RailRow
                file={props.row}
                workspace={props.workspace}
                directory={isDirectory()}
                depth={props.depth}
                expanded={expanded()}
                onToggle={(immediate) => {
                  setInstant(immediate);
                  props.workspace.onToggleDirectory?.(path());
                }}
              />
              <FileDisclosure
                variant="folder"
                open={expanded()}
                active={active()}
                instant={instant()}
              >
                <Errored
                  fallback={(error) => (
                    <div class="workspace-desktop__notice" role="alert">
                      {formatUiError(error())}
                    </div>
                  )}
                >
                  <Loading
                    on={directory()}
                    fallback={
                      <div class="workspace-desktop__notice" role="status">
                        {t("chat.workspaceFiles.loading")}
                      </div>
                    }
                  >
                    {latest(read)}
                    <Show when={isPending(read)}>
                      <div class="workspace-desktop__notice" role="status">
                        {t("chat.workspaceFiles.loading")}
                      </div>
                    </Show>
                  </Loading>
                </Errored>
                <Show when={browser()?.truncated}>
                  <div class="workspace-desktop__notice" role="status">
                    {t("chat.workspaceFiles.truncated")}
                  </div>
                </Show>
                <WorkspaceRows
                  rows={props.childrenByPath.get(path()) ?? []}
                  workspace={props.workspace}
                  childrenByPath={props.childrenByPath}
                  depth={props.depth + 1}
                  viewport={props.viewport}
                  content={props.content}
                  active={props.active && expanded()}
                />
              </FileDisclosure>
            </>
          );
        }}
      </Show>
    </div>
  );
}
