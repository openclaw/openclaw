import type { JSX } from "@solidjs/web";
import { createMemo, createRenderEffect, For } from "solid-js";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import panelStyles from "../../styles/panel-loading-skeleton.css?inline";

export type PanelLoadingSkeletonVariant =
  | "board"
  | "browser"
  | "chat"
  | "desktop"
  | "discussion"
  | "document"
  | "file-list"
  | "files"
  | "review"
  | "terminal";

export type PanelLoadingSkeletonProps = {
  variant?: PanelLoadingSkeletonVariant;
  label: string;
  compact?: boolean;
  overlay?: boolean;
};

type PanelLoadingSkeletonElement = SolidBridgeElement<PanelLoadingSkeletonProps>;

type LineWidth = "short" | "medium" | "long";

function Line(props: { width?: LineWidth }) {
  return <div class={["skeleton line", props.width ?? "long"]} />;
}

function Lines(props: { widths: readonly LineWidth[] }) {
  return <For each={props.widths}>{(width) => <Line width={width} />}</For>;
}

function Rows() {
  return (
    <For each={[0, 1, 2, 3, 4]}>
      {(index) => (
        <div class="row">
          <div class="skeleton icon" />
          <div class="copy">
            <Line width={index % 2 === 0 ? "long" : "medium"} />
            <div class="skeleton meta" />
          </div>
        </div>
      )}
    </For>
  );
}

function Widget(props: { columns: number; rows: number; lines: LineWidth[] }) {
  return (
    <div
      class="widget"
      style={{ "grid-column": `span ${props.columns}`, "grid-row": `span ${props.rows}` }}
    >
      <div class="widget-bar">
        <div class="skeleton icon" />
        <Line width="short" />
      </div>
      <div class="widget-body">
        <Lines widths={props.lines} />
      </div>
    </div>
  );
}

export function PanelLoadingSkeletonContent(props: PanelLoadingSkeletonProps) {
  const variant = createMemo(() => props.variant ?? "files");
  const content = (): JSX.Element => {
    switch (variant()) {
      case "board":
        return (
          <>
            <div class="board-tabs">
              <div class="skeleton tab" />
              <div class="skeleton tab" />
            </div>
            <div class="board-grid">
              <Widget columns={6} rows={4} lines={["long", "medium", "short"]} />
              <Widget columns={6} rows={4} lines={["medium", "long"]} />
              <Widget columns={4} rows={3} lines={["medium", "short"]} />
              <Widget columns={8} rows={3} lines={["long", "medium", "long"]} />
            </div>
          </>
        );
      case "browser":
        return (
          <>
            <div class="toolbar">
              <div class="skeleton button" />
              <div class="skeleton button" />
              <div class="skeleton address" />
            </div>
            <div class="skeleton viewport" />
          </>
        );
      case "chat":
        return (
          <div class="conversation">
            <For each={[["long", "medium"], ["medium"], ["long", "short"]] satisfies LineWidth[][]}>
              {(widths, index) => (
                <div class={["bubble", { user: index() === 1 }]}>
                  <div class="copy">
                    <Lines widths={widths} />
                  </div>
                </div>
              )}
            </For>
          </div>
        );
      case "desktop":
        return (
          <div class="desktop-loading">
            <span class="desktop-spinner" aria-hidden="true" />
            <span>{props.label}</span>
          </div>
        );
      case "discussion":
        return (
          <div class="discussion-frame">
            <div class="conversation">
              <Lines widths={["medium", "long", "long", "short"]} />
            </div>
          </div>
        );
      case "file-list":
        return (
          <div class="rows">
            <Rows />
          </div>
        );
      case "document":
      case "review":
        return (
          <>
            {variant() === "review" ? (
              <div class="summary">
                <div class="skeleton pill" />
                <div class="skeleton pill" />
              </div>
            ) : undefined}
            <div class={["skeleton file-heading", { medium: variant() === "document" }]} />
            <div class="code">
              <Lines widths={["long", "long", "medium", "long", "short"]} />
            </div>
          </>
        );
      case "terminal":
        return (
          <>
            <div class="toolbar">
              <div class="skeleton pill" />
              <div class="skeleton pill" />
            </div>
            <div class="terminal">
              <Lines widths={["medium", "long", "short", "long"]} />
            </div>
          </>
        );
      default:
        return (
          <>
            <div class="toolbar">
              <div class="skeleton address" />
              <div class="skeleton button" />
            </div>
            <div class="rows">
              <Rows />
            </div>
          </>
        );
    }
  };
  return <>{content()}</>;
}

export const PanelLoadingSkeleton = defineSolidBridge<PanelLoadingSkeletonProps>(
  "openclaw-panel-loading-skeleton",
  (props, host) => {
    host.setAttribute("role", "status");
    host.setAttribute("aria-busy", "true");
    // Native host accessibility attributes must commit with the skeleton content.
    createRenderEffect(
      () => ({ variant: props.variant ?? "files", label: props.label }),
      (value) => {
        host.setAttribute("data-panel-skeleton", value.variant);
        host.setAttribute("aria-label", value.label);
      },
    );
    return (
      <>
        <style>{panelStyles}</style>
        <PanelLoadingSkeletonContent {...props} />
      </>
    );
  },
  {
    properties: {
      variant: { default: "files", attribute: "data-panel-skeleton", reflect: true },
      label: { default: "" },
      compact: { default: false, type: Boolean, reflect: true },
      overlay: { default: false, type: Boolean, reflect: true },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-panel-loading-skeleton": PanelLoadingSkeletonElement;
  }
}
