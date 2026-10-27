import { createMemo, For, Show } from "solid-js";
import { parseBoardReport, type BoardReport } from "../../../../../src/boards/board-report.ts";
import { BoardWidgetError } from "../../../components/board/board-widget-error.tsx";
import { registerBoardDocumentEnglish } from "../../../i18n/locales/en-board-document.ts";
import { registerEnglishCatalog, t } from "../../reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../solid-bridge.ts";
import type { BoardWidget } from "../types.ts";
import "./report.css";

registerEnglishCatalog(registerBoardDocumentEnglish);

type ReportBlock = BoardReport["blocks"][number];
type ReportWidgetProps = { widget?: BoardWidget };

function ReportChart(props: { block: Extract<ReportBlock, { type: "chart" }> }) {
  const geometry = createMemo(() => {
    const values = props.block.points.map((point) => point.value);
    const minimum = Math.min(0, ...values);
    const span = Math.max(0, ...values) - minimum || 1;
    const y = (value: number) => 164 - ((value - minimum) / span) * 148;
    const line = props.block.style === "line";
    const width = 608 / props.block.points.length;
    return {
      baseline: y(0),
      line,
      width,
      coordinates: values.map((value, index) => ({
        x: line
          ? values.length === 1
            ? 320
            : 16 + (index / (values.length - 1)) * 608
          : 16 + (index + 0.5) * width,
        y: y(value),
      })),
    };
  });
  return (
    <figure class="board-report__chart">
      <Show when={props.block.title}>
        <figcaption>{props.block.title}</figcaption>
      </Show>
      <svg viewBox="0 0 640 180" aria-hidden="true">
        <line
          class="board-report__axis"
          x1="16"
          x2="624"
          y1={geometry().baseline}
          y2={geometry().baseline}
        />
        <Show
          when={geometry().line}
          fallback={
            <For each={geometry().coordinates}>
              {(point) => (
                <rect
                  class="board-report__bar"
                  x={point.x - geometry().width * 0.35}
                  y={Math.min(point.y, geometry().baseline)}
                  width={geometry().width * 0.7}
                  height={Math.max(1, Math.abs(point.y - geometry().baseline))}
                  rx="2"
                />
              )}
            </For>
          }
        >
          <polyline
            class="board-report__line"
            points={geometry()
              .coordinates.map((point) => `${point.x},${point.y}`)
              .join(" ")}
          />
          <For each={geometry().coordinates}>
            {(point) => <circle class="board-report__point" cx={point.x} cy={point.y} r="3" />}
          </For>
        </Show>
      </svg>
      <dl class="board-report__values">
        <For each={props.block.points}>
          {(point) => (
            <div>
              <dt>{point.label}</dt>
              <dd>{point.value}</dd>
            </div>
          )}
        </For>
      </dl>
    </figure>
  );
}

function ReportBlockView(props: { block: ReportBlock }) {
  const content = createMemo(() => {
    const block = props.block;
    switch (block.type) {
      case "text":
        return (
          <section>
            <Show when={block.title}>
              <h3>{block.title}</h3>
            </Show>
            <p class="board-report__text">{block.text}</p>
          </section>
        );
      case "metrics":
        return (
          <dl class="board-report__metrics">
            <For each={block.items}>
              {(item) => (
                <div>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                  <Show when={item.detail}>
                    <dd class="board-report__metric-detail">{item.detail}</dd>
                  </Show>
                </div>
              )}
            </For>
          </dl>
        );
      case "table":
        return (
          <div class="board-report__table">
            <table>
              <Show when={block.title}>
                <caption>{block.title}</caption>
              </Show>
              <thead>
                <tr>
                  <For each={block.columns}>{(column) => <th scope="col">{column}</th>}</For>
                </tr>
              </thead>
              <tbody>
                <For each={block.rows}>
                  {(row) => (
                    <tr>
                      <For each={row}>{(cell) => <td>{cell}</td>}</For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        );
      case "chart":
        return <ReportChart block={block} />;
      case "links":
        return (
          <section>
            <Show when={block.title}>
              <h3>{block.title}</h3>
            </Show>
            <ul class="board-report__links">
              <For each={block.items}>
                {(item) => (
                  <li>
                    <a href={item.url} target="_blank" rel="noopener noreferrer">
                      {item.label}
                    </a>
                    <Show when={item.detail}>
                      <span>{item.detail}</span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </section>
        );
    }
    return block satisfies never;
  });
  return <>{content()}</>;
}

function ReportWidgetContent(props: ReportWidgetProps) {
  const content = createMemo(
    () => {
      try {
        return { report: parseBoardReport(props.widget?.props) };
      } catch (error) {
        return { error };
      }
    },
    {
      // Keep parsed content and focus when only the widget metadata changes.
      equals: (previous, next) =>
        previous.report !== undefined &&
        next.report !== undefined &&
        JSON.stringify(previous.report) === JSON.stringify(next.report),
    },
  );
  return (
    <Show when={content().report} fallback={<BoardWidgetError error={content().error} />}>
      {(report) => (
        <article
          class="board-report"
          aria-label={props.widget?.title ?? t("board.widget.kindReport")}
        >
          <For each={report().blocks}>{(block) => <ReportBlockView block={block} />}</For>
        </article>
      )}
    </Show>
  );
}
export const ReportWidget = defineSolidBridge<ReportWidgetProps>(
  "openclaw-report-widget",
  ReportWidgetContent,
  { properties: { widget: { default: undefined, attribute: false } } },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-report-widget": SolidBridgeElement<ReportWidgetProps>;
  }
}
