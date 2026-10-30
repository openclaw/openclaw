import { createSignal, lazy, onSettled, Show } from "solid-js";
import { warmWhenIdle } from "../../../lib/idle-warmup.ts";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import { listen } from "../../../lib/reactive/listener.ts";

export type ComposerWidthOptions = {
  chatMessageMaxWidth?: string | null;
  onComposerWidthChange?: (value: string | undefined) => void;
  getTranscriptElement?: () => HTMLElement | null;
};

try {
  // Width geometry reads the transcript's reading inset in pixels.
  CSS.registerProperty({
    name: "--chat-thread-inline-inset",
    syntax: "<length>",
    inherits: true,
    initialValue: "0px",
  });
} catch {
  // A module reload finds it already registered.
}

/** The transcript's reading column: no Details track, scrollbar gutters, or reading inset. */
export function transcriptColumnWidth(transcript: HTMLElement) {
  const style = getComputedStyle(transcript);
  // Desktop CSS reserves Details in the second track; the first is the reading column.
  const column =
    style.display === "grid"
      ? Number.parseFloat(style.gridTemplateColumns)
      : transcript.clientWidth;
  return column - 2 * Number.parseFloat(style.getPropertyValue("--chat-thread-inline-inset"));
}

/**
 * Keep a saved width inside the transcript's reading column from the first frame.
 * CSS already caps the composer to its own region; the saved width stays live through
 * the variable. The default 48rem floor keeps a saved width from ever making the composer
 * narrower than the unsaved default; mounted only while a width is saved.
 */
function ColumnCap(props: {
  transcript: () => HTMLElement | null | undefined;
  shell: () => HTMLElement | undefined;
}) {
  const cap = () => {
    const transcript = props.transcript();
    props
      .shell()
      ?.style.setProperty(
        "max-width",
        transcript?.isConnected
          ? `min(var(--chat-thread-max-width), max(48rem, ${transcriptColumnWidth(transcript)}px))`
          : null,
      );
  };
  const schedule = createLayoutMeasurement(() => props.transcript(), cap, {
    targets: (transcript) =>
      [props.shell(), transcript].filter((node): node is HTMLElement => Boolean(node)),
    changeTiming: "sync",
  });
  onSettled(() => {
    schedule();
    // Release a mobile cap before paint, rather than a frame after ResizeObserver delivery.
    const stopResize = listen(window, "resize", cap);
    return () => {
      stopResize();
      props.shell()?.style.removeProperty("max-width");
    };
  });
  return null;
}

// Saved widths apply through --chat-thread-max-width from the first frame. The
// edge's gestures and geometry stay outside chat boot: idle warmup loads them.
const ResizeEdge = lazy(() => import("./chat-composer-width-edge.tsx"), { export: "ResizeEdge" });
const [ready, setReady] = createSignal(false);
export const loadComposerWidthEdge = () =>
  ResizeEdge.preload().then(
    () => setReady(true),
    () => undefined,
  );
warmWhenIdle(loadComposerWidthEdge);

/** Composer shell pointer/key intent loads the edge when idle warmup is skipped (Save-Data). */
export const prepareComposerWidthEdge = () => void loadComposerWidthEdge();

/**
 * Render directly after the composer input. Saved widths on writable surfaces with a
 * transcript keep the column cap; the edge mounts once loaded. Settings retain saved width.
 */
export function ComposerWidthEdge(props: {
  options: () => ComposerWidthOptions;
  shell?: () => HTMLElement | undefined;
}) {
  return (
    <Show when={props.options().onComposerWidthChange}>
      <Show when={props.options().chatMessageMaxWidth}>
        <ColumnCap
          transcript={() => props.options().getTranscriptElement?.()}
          shell={() => props.shell?.()}
        />
      </Show>
      <Show when={ready()}>
        <ResizeEdge options={props.options} />
      </Show>
    </Show>
  );
}
