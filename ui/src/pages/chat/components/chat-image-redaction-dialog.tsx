import { createSignal, onSettled } from "solid-js";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerImageRedactionEnglish } from "../../../i18n/locales/en-image-redaction.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createPointerDrag } from "../../../lib/reactive/pointer-drag.ts";
import { paintImageRedactions, type ImageRedactionRectangle } from "./chat-image-redaction.ts";

registerEnglishCatalog(registerChatComposerEnglish);
registerEnglishCatalog(registerImageRedactionEnglish);

export async function showImageRedaction(blob: Blob, signal?: AbortSignal): Promise<string | null> {
  const image = await createImageBitmap(blob);
  try {
    if (signal?.aborted) {
      return null;
    }
    if (image.width * image.height > 16_000_000) {
      throw new Error(t("chat.attachments.redactionTooLarge"));
    }
    return await withPromiseModalHost<string | null>({ signal, value: null }, (modal) =>
      modal.render(() => <ImageRedaction image={image} onFinish={modal.finish} />),
    );
  } finally {
    image.close();
  }
}

export function ImageRedaction(props: {
  image: ImageBitmap;
  onFinish: (value: string | null) => void;
}) {
  const drag = createPointerDrag();
  const rectangles: ImageRedactionRectangle[] = [];
  const [count, setCount] = createSignal(0);
  let canvas!: HTMLCanvasElement;
  let active = false;
  const paint = (preview?: ImageRedactionRectangle) => {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error(t("chat.attachments.redactionFailed"));
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(props.image, 0, 0);
    paintImageRedactions(
      context,
      canvas.width,
      canvas.height,
      preview ? [...rectangles, preview] : rectangles,
    );
  };
  onSettled(() => paint());
  const start = (event: PointerEvent) => {
    if (event.button !== 0 || active) {
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const point = (value: PointerEvent) => ({
      x: Math.max(0, Math.min(1, (value.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (value.clientY - bounds.top) / bounds.height)),
    });
    const origin = point(event);
    const rectangle = (value: PointerEvent) => {
      const end = point(value);
      return {
        x: Math.min(origin.x, end.x),
        y: Math.min(origin.y, end.y),
        width: Math.abs(end.x - origin.x),
        height: Math.abs(end.y - origin.y),
      };
    };
    active = drag.start(event, canvas, {
      move: (next) => paint(rectangle(next)),
      end: (next) => {
        active = false;
        const selected = rectangle(next);
        if (selected.width * canvas.width >= 1 && selected.height * canvas.height >= 1) {
          rectangles.push(selected);
        }
        paint();
        setCount(rectangles.length);
      },
      cancel: () => {
        active = false;
        paint();
      },
    });
    if (active) {
      event.preventDefault();
    }
  };
  return (
    <openclaw-modal-dialog
      label={t("chat.attachments.redactImage")}
      onModal-cancel={() => props.onFinish(null)}
      style={{ "--openclaw-modal-width": "52rem" }}
    >
      <div
        class="chat-image-redaction"
        style={{
          display: "grid",
          gap: "0.75rem",
          padding: "1rem",
          "border-radius": "var(--radius-xl)",
          background: "var(--bg)",
        }}
      >
        <p style={{ margin: 0 }}>{t("chat.attachments.redactionHint")}</p>
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
            width={props.image.width}
            height={props.image.height}
            style={{
              display: "block",
              width: "100%",
              height: "auto",
              cursor: "crosshair",
              "touch-action": "none",
            }}
            aria-label={t("chat.attachments.redactionCanvas")}
            onPointerDown={start}
          />
        </div>
        <p role="status" style={{ margin: 0 }}>
          {t("chat.attachments.redactionCount", { count: String(count()) })}
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
              rectangles.pop();
              paint();
              setCount(rectangles.length);
            }}
          >
            {t("chat.attachments.redactionUndo")}
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
            {t("chat.attachments.redactionApply")}
          </button>
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}
