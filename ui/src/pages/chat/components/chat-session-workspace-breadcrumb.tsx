import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onSettled,
  Show,
} from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { splitWorkspaceFilename } from "./chat-session-workspace-catalog.ts";

export type WorkspaceBreadcrumbProps = {
  /** Canonical workspace-relative path. External/artifact identity uses sourceLabel instead. */
  path: string;
  rootLabel: string;
  sourceLabel?: string;
  name?: string;
  onBrowsePath: (path: string) => void;
};

/** Folder actions belong to the current tab; this component never opens or renames a tab. */
export function WorkspaceBreadcrumb(props: WorkspaceBreadcrumbProps) {
  let container: HTMLElement | undefined;
  let current: HTMLSpanElement | undefined;
  let source: HTMLSpanElement | undefined;
  let measureName: HTMLSpanElement | undefined;
  const id = createUniqueId();
  const elements = new Map<string, HTMLSpanElement>();
  const [hidden, setHidden] = createSignal<string[]>([]);
  const [displayName, setDisplayName] = createSignal<string>();
  let textMeasure: CanvasRenderingContext2D | null | undefined;
  const parents = createMemo(() => {
    if (props.sourceLabel) {
      return [];
    }
    const parts = props.path.split("/").filter(Boolean);
    if (!parts.length) {
      return [];
    }
    return [
      { path: "", label: props.rootLabel },
      ...parts
        .slice(0, -1)
        .map((label, index) => ({ label, path: parts.slice(0, index + 1).join("/") })),
    ];
  });
  const name = () => props.name ?? (props.path.split("/").at(-1) || props.rootLabel);
  const measure = () => {
    if (!container?.clientWidth || !current) {
      return;
    }
    const entries = parents();
    const available = Math.max(
      0,
      container.clientWidth - (props.sourceLabel ? (source?.offsetWidth ?? 0) : 0),
    );
    const widths = entries.map((entry) => elements.get(entry.path)?.offsetWidth ?? 0);
    const nameWidth = measureName?.offsetWidth ?? current.scrollWidth;
    let width = widths.reduce((sum, value) => sum + value, 0) + nameWidth;
    const next: string[] = [];
    // Remove whole middle ancestors before the root and immediate parent.
    const order = [
      ...entries.slice(1, -1),
      ...entries.slice(0, 1),
      ...(entries.length > 1 ? entries.slice(-1) : []),
    ];
    for (const entry of order) {
      if (width <= available) {
        break;
      }
      if (!next.length) {
        width += 38;
      }
      width -= elements.get(entry.path)?.offsetWidth ?? 0;
      next.push(entry.path);
    }
    setHidden(next);
    const fullName = name();
    const room = Math.max(0, available - (width - nameWidth));
    if (nameWidth <= room) {
      setDisplayName(fullName);
      return;
    }
    textMeasure ??= document.createElement("canvas").getContext("2d");
    if (!textMeasure) {
      return;
    }
    textMeasure.font = getComputedStyle(current).font;
    const { stem, extension } = splitWorkspaceFilename(fullName);
    const characters = Array.from(stem);
    let low = 0;
    let high = characters.length - 1;
    let fitted = `…${extension}`;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const start = Math.ceil(count * 0.6);
      const end = count - start;
      const candidate = `${characters.slice(0, start).join("")}…${end ? characters.slice(-end).join("") : ""}${extension}`;
      if (textMeasure.measureText(candidate).width <= room) {
        fitted = candidate;
        low = count + 1;
      } else {
        high = count - 1;
      }
    }
    setDisplayName(fitted);
  };
  createEffect(
    () => [props.path, props.rootLabel, props.name, props.sourceLabel],
    () => measure(),
  );
  onSettled(() => {
    if (!container) {
      return undefined;
    }
    let active = true;
    const update = () => {
      if (active) {
        measure();
      }
    };
    const observer = new ResizeObserver(update);
    observer.observe(container);
    update();
    void document.fonts.ready.then(update);
    return () => {
      active = false;
      observer.disconnect();
    };
  });
  const browse = (path: string) => {
    props.onBrowsePath(path);
  };
  return (
    <nav
      class="workspace-breadcrumb"
      aria-label={t("chat.workspaceFiles.desktop.filePath")}
      ref={(element) => {
        container = element;
      }}
    >
      <Show when={props.sourceLabel}>
        <span
          class="workspace-breadcrumb__source"
          ref={(element) => {
            source = element;
          }}
        >
          {props.sourceLabel}
          <Icon name="chevronRight" />
        </span>
      </Show>
      <For each={parents()} keyed={(entry) => entry.path}>
        {(entry) => (
          <span
            class={[
              "workspace-breadcrumb__part",
              { "is-overflowed": hidden().includes(entry().path) },
            ]}
            style={{ order: parents().findIndex((parent) => parent.path === entry().path) * 2 }}
            aria-hidden={hidden().includes(entry().path) ? "true" : "false"}
            ref={(element) => {
              elements.set(entry().path, element);
            }}
          >
            <button
              type="button"
              tabindex={hidden().includes(entry().path) ? -1 : undefined}
              onClick={() => browse(entry().path)}
            >
              {entry().label}
            </button>
            <Icon name="chevronRight" />
          </span>
        )}
      </For>
      <Show when={hidden().length > 0}>
        <div
          style={{
            order: Math.min(
              ...parents().map((parent, index) =>
                hidden().includes(parent.path) ? index * 2 : Infinity,
              ),
            ),
          }}
          class="workspace-breadcrumb__overflow"
        >
          <Menu
            id={`workspace-folders-${id}`}
            label={t("chat.workspaceFiles.desktop.hiddenFolders")}
            panelClass="workspace-desktop__menu"
            trigger={
              <>
                <Icon name="moreHorizontal" />
                <Icon name="chevronRight" />
              </>
            }
            items={parents()
              .filter((entry) => hidden().includes(entry.path))
              .map((entry) => ({
                id: `folder:${entry.path}`,
                label: entry.label,
                icon: <Icon name="folder" />,
              }))}
            onSelect={(item) => {
              const entry = parents().find((parent) => `folder:${parent.path}` === item.id);
              if (entry) {
                browse(entry.path);
              }
            }}
          />
        </div>
      </Show>
      <span
        aria-hidden="true"
        class="workspace-breadcrumb__measure"
        ref={(element) => {
          measureName = element;
        }}
      >
        {name()}
      </span>
      <span
        style={{ order: parents().length * 2 + 2 }}
        class="workspace-breadcrumb__current"
        aria-current="page"
        title={props.path || name()}
        aria-label={name()}
        ref={(element) => {
          current = element;
        }}
      >
        {displayName() ?? name()}
      </span>
    </nav>
  );
}
