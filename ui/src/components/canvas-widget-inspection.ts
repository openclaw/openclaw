import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export type WidgetInspection =
  | { kind: "hover"; rect?: DOMRect }
  | { kind: "pick"; rect: DOMRect; label: string; frame: HTMLIFrameElement }
  | { kind: "cancel" };

export type WidgetInspectionListener = (event: WidgetInspection) => void;

/** Translate the opaque widget's viewport to CSS pixels in the admitted host frame. */
function readWidgetInspection(
  data: Record<string, unknown>,
  frame: HTMLIFrameElement,
): WidgetInspection | undefined {
  if (data.type === "openclaw:widget-inspect-cancel") {
    return { kind: "cancel" };
  }
  const hover = data.type === "openclaw:widget-inspect-hover";
  if (!hover && data.type !== "openclaw:widget-inspect-pick") {
    return undefined;
  }
  const box = asOptionalRecord(data.rect);
  const { left, top, right, bottom } = box ?? {};
  if (
    typeof left !== "number" ||
    typeof top !== "number" ||
    typeof right !== "number" ||
    typeof bottom !== "number" ||
    ![left, top, right, bottom].every(Number.isFinite)
  ) {
    return hover ? { kind: "hover" } : undefined;
  }
  const width = frame.clientWidth;
  const height = frame.clientHeight;
  const x = Math.max(0, left);
  const y = Math.max(0, top);
  const w = Math.min(width, right) - x;
  const h = Math.min(height, bottom) - y;
  if (w <= 0 || h <= 0) {
    return hover ? { kind: "hover" } : undefined;
  }
  const rect = new DOMRect(x, y, w, h);
  if (hover) {
    return { kind: "hover", rect };
  }
  if (typeof data.tag !== "string" || !/^[a-z][\w-]{0,39}$/u.test(data.tag)) {
    return undefined;
  }
  const id = typeof data.id === "string" ? data.id.slice(0, 80).replace(/[^\w-]/gu, "") : "";
  const text =
    typeof data.text === "string"
      ? data.text.slice(0, 240).replace(/\s+/gu, " ").trim().toWellFormed()
      : "";
  return {
    kind: "pick",
    frame,
    rect,
    label: [data.tag + (id ? `#${id}` : ""), text].filter(Boolean).join(": "),
  };
}

export function widgetInspectionAnchor(frame: HTMLIFrameElement, rect: DOMRect): DOMRect {
  const bounds = frame.getBoundingClientRect();
  const scaleX = bounds.width / frame.offsetWidth || 1;
  const scaleY = bounds.height / frame.offsetHeight || 1;
  return new DOMRect(
    bounds.left + (frame.clientLeft + rect.left) * scaleX,
    bounds.top + (frame.clientTop + rect.top) * scaleY,
    rect.width * scaleX,
    rect.height * scaleY,
  );
}

/** The current Canvas owner admits this private port and retires it with the frame. */
export function createWidgetInspection() {
  let ready = false;
  let sequence = 0;
  let active: { id: number; receive: WidgetInspectionListener; port: MessagePort } | undefined;
  const setMode = (port: MessagePort, inspection: number) => {
    // MessagePort is paired with this wrapper instance, not a Window target.
    port.postMessage({ type: "openclaw:widget-inspect-mode", inspection });
  };
  function stop() {
    const session = active;
    if (session) {
      active = undefined;
      setMode(session.port, 0);
      session.receive({ kind: "cancel" });
    }
  }
  return {
    stop,
    reset() {
      stop();
      ready = false;
    },
    start(port: MessagePort, receive: WidgetInspectionListener): (() => void) | undefined {
      if (!ready) {
        return undefined;
      }
      stop();
      const session = { id: ++sequence, port, receive };
      active = session;
      setMode(port, session.id);
      return () => {
        if (active === session) {
          stop();
        }
      };
    },
    receive(data: Record<string, unknown>, frame: HTMLIFrameElement) {
      if (data.type === "openclaw:widget-inspect-ready") {
        ready = true;
      } else if (active && data.inspection === active.id) {
        const update = readWidgetInspection(data, frame);
        if (update?.kind === "cancel") {
          stop();
        } else if (update) {
          active.receive(update);
        }
      }
    },
  };
}
