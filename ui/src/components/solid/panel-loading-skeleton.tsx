import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import "../../styles/panel-loading-skeleton.css";

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

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-panel-loading-skeleton": HTMLAttributes<HTMLElement> & {
        compact?: string;
        overlay?: string;
      };
    }
  }
}

type LineWidth = "short" | "medium" | "long";

function Line(props: { width?: LineWidth }) {
  return <div class={`skeleton line ${props.width ?? "long"}`} />;
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
        <For each={props.lines}>{(width) => <Line width={width} />}</For>
      </div>
    </div>
  );
}

export function PanelLoadingSkeletonContent(props: PanelLoadingSkeletonProps) {
  const content = (): JSX.Element => {
    switch (props.variant ?? "files") {
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
            <div class="bubble">
              <div class="copy">
                <Line />
                <Line width="medium" />
              </div>
            </div>
            <div class="bubble user">
              <div class="copy">
                <Line width="medium" />
              </div>
            </div>
            <div class="bubble">
              <div class="copy">
                <Line />
                <Line width="short" />
              </div>
            </div>
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
              <Line width="medium" />
              <Line />
              <Line />
              <Line width="short" />
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
        return (
          <>
            <div class="skeleton file-heading medium" />
            <div class="code">
              <Line />
              <Line />
              <Line width="medium" />
              <Line />
              <Line width="short" />
            </div>
          </>
        );
      case "review":
        return (
          <>
            <div class="summary">
              <div class="skeleton pill" />
              <div class="skeleton pill" />
            </div>
            <div class="skeleton file-heading" />
            <div class="code">
              <Line />
              <Line />
              <Line width="medium" />
              <Line />
              <Line width="short" />
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
              <Line width="medium" />
              <Line />
              <Line width="short" />
              <Line />
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

export function PanelLoadingSkeleton(props: PanelLoadingSkeletonProps) {
  return (
    <openclaw-panel-loading-skeleton
      data-panel-skeleton={props.variant ?? "files"}
      compact={props.compact ? "" : undefined}
      overlay={props.overlay ? "" : undefined}
      role="status"
      aria-busy="true"
      aria-label={props.label}
    >
      <PanelLoadingSkeletonContent {...props} />
    </openclaw-panel-loading-skeleton>
  );
}
