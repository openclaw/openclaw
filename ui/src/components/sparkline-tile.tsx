import "../styles/gateway-vitals.css";
import { createMemo, createSignal, For, Show } from "solid-js";
import { formatDurationCompact } from "../lib/format-duration.ts";
import { i18nRevision } from "../lib/reactive/i18n.ts";
import type { SparklineSample } from "../lib/sparkline-types.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";

export type { SparklineSample } from "../lib/sparkline-types.ts";

type SparklineProps = {
  label: string;
  sub: string;
  samples: readonly SparklineSample[];
  format: (value: number) => string;
  floorMax: number;
  stackColors: readonly string[];
  autorange: boolean;
};

// Chart geometry in viewBox units; HTML markers use percentages as the SVG stretches.
const CHART_WIDTH = 100;
const CHART_HEIGHT = 40;
const CHART_TOP_PAD = 4;
let gradientCounter = 0;

function SparklineContent(props: SparklineProps) {
  const gradientId = `sparkline-tile-gradient-${++gradientCounter}`;
  const [hoverIndex, setHoverIndex] = createSignal<number | null>(null);
  const range = createMemo(() => {
    let max = props.floorMax;
    let min = Number.POSITIVE_INFINITY;
    for (const sample of props.samples) {
      if (sample.value > max) {
        max = sample.value;
      }
      if (sample.value < min) {
        min = sample.value;
      }
    }
    if (!Number.isFinite(min)) {
      min = 0;
    }
    if (!props.autorange) {
      return { min: 0, span: max > 0 ? max : 1 };
    }
    // Keep a steady metric's trend visible without implying a drop to zero.
    const spread = Math.max(max - min, max * 0.02, 1e-9);
    const base = Math.max(min - spread * 0.5, 0);
    return { min: base, span: Math.max(max - base, 1e-9) };
  });
  const toY = (value: number) => {
    const scale = range();
    const ratio = Math.min(Math.max((value - scale.min) / scale.span, 0), 1);
    return CHART_HEIGHT - ratio * (CHART_HEIGHT - CHART_TOP_PAD);
  };
  const step = () => CHART_WIDTH / (props.samples.length - 1);
  const points = createMemo(() =>
    props.samples.map((sample, index) => `${index * step()},${toY(sample.value)}`).join(" "),
  );
  const stack = createMemo(() =>
    props.stackColors.flatMap((color, layer) => {
      const polygons: { points: string; color: string }[] = [];
      let upper: string[] = [];
      let lower: string[] = [];
      const finish = () => {
        if (upper.length > 1) {
          polygons.push({ points: [...upper, ...lower.toReversed()].join(" "), color });
        }
        upper = [];
        lower = [];
      };
      for (const [index, sample] of props.samples.entries()) {
        if (sample.stack?.length !== props.stackColors.length) {
          finish();
          continue;
        }
        const base = sample.stack.slice(0, layer).reduce((sum, value) => sum + value, 0);
        lower.push(`${index * step()},${toY(base)}`);
        upper.push(`${index * step()},${toY(base + sample.stack[layer]!)}`);
      }
      finish();
      return polygons;
    }),
  );
  const current = () => props.samples.at(-1);
  const hover = () => (hoverIndex() !== null ? props.samples[hoverIndex()!] : undefined);
  const shown = () => hover() ?? current();
  const value = createMemo(() => {
    i18nRevision();
    return shown() ? props.format(shown()!.value) : "–";
  });
  const hoverLeft = () =>
    hoverIndex() !== null ? (hoverIndex()! / (props.samples.length - 1)) * 100 : 0;
  const age = createMemo(() => {
    i18nRevision();
    const previous = hover();
    const latest = current();
    return previous && latest && latest.at > previous.at
      ? formatDurationCompact(latest.at - previous.at)
      : null;
  });
  return (
    <>
      <div class="sparkline-tile__head">
        <span class="sparkline-tile__label">{props.label}</span>{" "}
        <Show when={props.sub}>
          <span class="sparkline-tile__sub mono">{props.sub}</span>
        </Show>
      </div>
      <div class="sparkline-tile__value mono">
        {value()}{" "}
        <Show when={age()}>
          <span class="sparkline-tile__age">−{age()}</span>
        </Show>
      </div>
      <Show when={shown()?.secondary}>
        <div class="sparkline-tile__secondary">{shown()?.secondary}</div>
      </Show>
      <Show when={props.samples.length >= 2}>
        <div
          class="sparkline-tile__chart"
          onPointerMove={(event) => {
            const ratio = event.offsetX / Math.max(event.currentTarget.clientWidth, 1);
            setHoverIndex(
              Math.min(
                Math.max(Math.round(ratio * (props.samples.length - 1)), 0),
                props.samples.length - 1,
              ),
            );
          }}
          onPointerLeave={() => setHoverIndex(null)}
        >
          <svg
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="currentColor" stop-opacity="0.28" />
                <stop offset="1" stop-color="currentColor" stop-opacity="0.02" />
              </linearGradient>
            </defs>
            <polygon
              points={`0,${CHART_HEIGHT} ${points()} ${CHART_WIDTH},${CHART_HEIGHT}`}
              fill={`url(#${gradientId})`}
            />
            <For each={stack()}>
              {(polygon) => (
                <polygon
                  class="sparkline-tile__stack"
                  points={polygon.points}
                  fill={polygon.color}
                />
              )}
            </For>
            <polyline points={points()} />
          </svg>
          <Show when={hover()}>
            <div class="sparkline-tile__hairline" style={{ left: `${hoverLeft()}%` }} />
          </Show>
          <div
            class={`sparkline-tile__dot sparkline-tile__dot--${hover() ? "hover" : "now"}`}
            style={{
              left: hover() ? `${hoverLeft()}%` : "calc(100% - 3px)",
              top: `${(toY(shown()!.value) / CHART_HEIGHT) * 100}%`,
            }}
          />
        </div>
      </Show>
    </>
  );
}

export const SparklineTile = defineSolidBridge<SparklineProps>(
  "openclaw-sparkline",
  SparklineContent,
  {
    properties: {
      label: { default: "" },
      sub: { default: "" },
      samples: { default: [], attribute: false },
      format: { default: String, attribute: false },
      floorMax: { default: 0, attribute: false },
      stackColors: { default: [], attribute: false },
      autorange: { default: false },
    },
  },
);
