import { createSignal, onSettled } from "solid-js";
import {
  paintAnnotations,
  type AnnotationStroke,
} from "../../../components/browser/annotation-paint.ts";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createPointerDrag } from "../../../lib/reactive/pointer-drag.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { attachChatSketch } from "./chat-sketch.ts";

export async function openChatSketch(
  readControls: () => ChatAttachmentControlsProps,
): Promise<void> {
  const initial = readControls();
  const signal = initial.readSignal ?? initial.attachmentReads?.readSignal;
  if (initial.disabled || !uploadsEnabled(initial.uploadConfig) || signal?.aborted) {
    return;
  }
  const result = await withPromiseModalHost<string | null>({ signal, value: null }, (modal) =>
    modal.render(() => <SketchDialog onFinish={modal.finish} />),
  );
  const current = readControls();
  if (
    result &&
    !signal?.aborted &&
    signal === (current.readSignal ?? current.attachmentReads?.readSignal)
  ) {
    attachChatSketch(result, current);
  }
}

export function SketchDialog(props: { onFinish: (value: string | null) => void }) {
  const drag = createPointerDrag();
  const strokes: AnnotationStroke[] = [];
  const [count, setCount] = createSignal(0);
  let canvas!: HTMLCanvasElement;
  let drawing = false;
  const paint = (preview?: AnnotationStroke) => {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error(t("chat.composer.sketchFailed"));
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    paintAnnotations(context, {
      width: canvas.width,
      height: canvas.height,
      strokes: preview ? [...strokes, preview] : strokes,
    });
  };
  onSettled(() => paint());
  const start = (event: PointerEvent) => {
    if (event.button !== 0 || drawing) {
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const point = (value: PointerEvent) => ({
      x: Math.max(0, Math.min(1, (value.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (value.clientY - bounds.top) / bounds.height)),
    });
    const stroke: AnnotationStroke = { points: [point(event)] };
    drawing = drag.start(event, canvas, {
      move: (next) => {
        stroke.points.push(point(next));
        paint(stroke);
      },
      end: (next) => {
        drawing = false;
        stroke.points.push(point(next));
        strokes.push(stroke);
        paint();
        setCount(strokes.length);
      },
      cancel: () => {
        drawing = false;
        paint();
      },
    });
    if (drawing) {
      event.preventDefault();
      paint(stroke);
    }
  };
  return (
    <openclaw-modal-dialog
      label={t("chat.composer.drawSketch")}
      style={{ "--openclaw-modal-width": "52rem" }}
      onModal-cancel={() => props.onFinish(null)}
    >
      <div
        class="chat-sketch"
        style={{
          display: "grid",
          gap: "0.75rem",
          padding: "1rem",
          "border-radius": "var(--radius-xl)",
          background: "var(--bg)",
        }}
      >
        <p style={{ margin: 0 }}>{t("chat.composer.sketchHint")}</p>
        <div
          style={{
            "max-height": "min(55vh, var(--openclaw-modal-height-limit))",
            overflow: "auto",
          }}
        >
          <canvas
            ref={(element) => {
              canvas = element;
            }}
            width={800}
            height={450}
            style={{
              display: "block",
              width: "100%",
              height: "auto",
              cursor: "crosshair",
              "touch-action": "none",
              border: "1px solid var(--border)",
              "border-radius": "var(--radius-md)",
            }}
            aria-label={t("chat.composer.sketchCanvas")}
            onPointerDown={start}
          />
        </div>
        <p role="status" style={{ margin: 0 }}>
          {t("chat.composer.sketchCount", { count: String(count()) })}
        </p>
        <openclaw-modal-actions>
          <button class="btn" type="button" onClick={() => props.onFinish(null)}>
            {t("common.cancel")}
          </button>
          <button
            class="btn"
            type="button"
            disabled={count() === 0}
            onClick={() => {
              drag.cancel();
              strokes.pop();
              paint();
              setCount(strokes.length);
            }}
          >
            {t("chat.composer.sketchUndo")}
          </button>
          <button
            class="btn"
            type="button"
            disabled={count() === 0}
            onClick={() => {
              drag.cancel();
              strokes.length = 0;
              paint();
              setCount(0);
            }}
          >
            {t("chat.composer.sketchClear")}
          </button>
          <button
            class="btn primary"
            type="button"
            disabled={count() === 0}
            onClick={() => {
              drag.cancel();
              props.onFinish(canvas.toDataURL("image/png"));
            }}
          >
            {t("chat.composer.sketchAttach")}
          </button>
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}
