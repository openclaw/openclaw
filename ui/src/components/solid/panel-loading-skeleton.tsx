import type { JSX } from "@solidjs/web";
import { createMemo, For } from "solid-js";
import panelStyles from "../../styles/panel-loading-skeleton.css?inline";

export type PanelLoadingSkeletonVariant =
  | "board"
  | "browser"
  | "browser-viewport"
  | "chat"
  | "desktop"
  | "discussion"
  | "document"
  | "file-list"
  | "files"
  | "review"
  | "terminal";

type LineWidth = "short" | "medium" | "long";
type SkeletonNode = readonly [
  className: string,
  children?: readonly SkeletonNode[],
  style?: Readonly<JSX.CSSProperties>,
];

const lineClasses: Readonly<Record<LineWidth, string>> = {
  short: "skeleton line short",
  medium: "skeleton line medium",
  long: "skeleton line long",
};

function shape(
  className: string,
  children?: readonly SkeletonNode[],
  style?: Readonly<JSX.CSSProperties>,
): SkeletonNode {
  return [className, children, style];
}

function line(width: LineWidth = "long"): SkeletonNode {
  return shape(lineClasses[width]);
}

function lines(...widths: LineWidth[]): readonly SkeletonNode[] {
  return widths.map(line);
}

function rows(): readonly SkeletonNode[] {
  return Array.from({ length: 5 }, (_, index) =>
    shape("row", [
      shape("skeleton icon"),
      shape("copy", [line(index % 2 === 0 ? "long" : "medium"), shape("skeleton meta")]),
    ]),
  );
}

function widget(columns: number, rowSpan: number, widths: readonly LineWidth[]): SkeletonNode {
  return shape(
    "widget",
    [
      shape("widget-bar", [shape("skeleton icon"), line("short")]),
      shape("widget-body", lines(...widths)),
    ],
    { "grid-column": `span ${columns}`, "grid-row": `span ${rowSpan}` },
  );
}

// Immutable presentation data only; never shared JSX or DOM.
const layouts: Readonly<
  Record<Exclude<PanelLoadingSkeletonVariant, "desktop">, readonly SkeletonNode[]>
> = {
  board: [
    shape("board-tabs", [shape("skeleton tab"), shape("skeleton tab")]),
    shape("board-grid", [
      widget(6, 4, ["long", "medium", "short"]),
      widget(6, 4, ["medium", "long"]),
      widget(4, 3, ["medium", "short"]),
      widget(8, 3, ["long", "medium", "long"]),
    ]),
  ],
  browser: [
    shape("toolbar", [
      shape("skeleton button"),
      shape("skeleton button"),
      shape("skeleton address"),
    ]),
    shape("skeleton viewport"),
  ],
  "browser-viewport": [shape("skeleton viewport")],
  chat: [
    shape("conversation", [
      shape("bubble", [shape("copy", lines("long", "medium"))]),
      shape("bubble user", [shape("copy", lines("medium"))]),
      shape("bubble", [shape("copy", lines("long", "short"))]),
    ]),
  ],
  discussion: [
    shape("discussion-frame", [shape("conversation", lines("medium", "long", "long", "short"))]),
  ],
  "file-list": [shape("rows", rows())],
  document: [
    shape("skeleton file-heading medium"),
    shape("code", lines("long", "long", "medium", "long", "short")),
  ],
  review: [
    shape("summary", [shape("skeleton pill"), shape("skeleton pill")]),
    shape("skeleton file-heading"),
    shape("code", lines("long", "long", "medium", "long", "short")),
  ],
  terminal: [
    shape("toolbar", [shape("skeleton pill"), shape("skeleton pill")]),
    shape("terminal", lines("medium", "long", "short", "long")),
  ],
  files: [
    shape("toolbar", [shape("skeleton address"), shape("skeleton button")]),
    shape("rows", rows()),
  ],
};

function SkeletonNodes(props: { nodes: readonly SkeletonNode[] }) {
  return (
    <For each={props.nodes}>
      {(node) => (
        <div class={node[0]} style={node[2]}>
          {node[1] && <SkeletonNodes nodes={node[1]} />}
        </div>
      )}
    </For>
  );
}

export function PanelLoadingSkeleton(props: {
  variant?: PanelLoadingSkeletonVariant;
  label: string;
  compact?: boolean;
  overlay?: boolean;
}) {
  const variant = createMemo(() => props.variant ?? "files");
  const content = (): JSX.Element => {
    const current = variant();
    if (current === "desktop") {
      return (
        <div class="desktop-loading">
          <span class="desktop-spinner" aria-hidden="true" />
          <span>{props.label}</span>
        </div>
      );
    }
    return <SkeletonNodes nodes={layouts[current] ?? layouts.files} />;
  };

  return (
    <openclaw-panel-loading-skeleton
      role="status"
      aria-busy="true"
      data-panel-skeleton={props.variant ?? "files"}
      aria-label={props.label}
      compact={props.compact ? "" : undefined}
      overlay={props.overlay ? "" : undefined}
    >
      <style>{panelStyles}</style>
      <div class="panel-loading-content">{content()}</div>
    </openclaw-panel-loading-skeleton>
  );
}
