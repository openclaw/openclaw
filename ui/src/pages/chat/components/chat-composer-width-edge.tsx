import { onSettled } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import { createPointerDrag } from "../../../lib/reactive/pointer-drag.ts";
import { transcriptColumnWidth, type ComposerWidthOptions } from "./chat-composer-width-ref.tsx";

/**
 * Gesture and geometry owner for writable composers, loaded outside chat boot.
 * Callers render it in the composer shell directly after the input it measures.
 */
export function ResizeEdge(props: { options: () => ComposerWidthOptions }) {
  const options = () => props.options();
  const drag = createPointerDrag();
  let edge: HTMLDivElement | undefined;
  const shell = () => edge?.parentElement;
  const input = () => edge?.previousElementSibling;
  let retired = false;
  let dragging = false;
  let baseline: string | undefined;
  let lastWidth: string | null | undefined = null;
  let minimumWidth = 480;
  let refreshMinimum = true;
  // Solid can wrap the shell in a boxless display:contents host.
  const region = () => {
    let parent = shell()!.parentElement!;
    while (parent.parentElement && getComputedStyle(parent).display === "contents") {
      parent = parent.parentElement;
    }
    return parent;
  };
  const availableWidth = (current: ComposerWidthOptions) => {
    const parent = region();
    const style = getComputedStyle(parent);
    const shellStyle = getComputedStyle(shell()!);
    const inset =
      Number.parseFloat(shellStyle.getPropertyValue("--chat-composer-inline-inset")) ||
      (Number.parseFloat(shellStyle.getPropertyValue("--chat-composer-side-inset")) || 36) / 2;
    let available =
      parent.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight) -
      2 * inset;
    const transcript = current.getTranscriptElement?.();
    if (transcript?.isConnected) {
      available = Math.min(available, transcriptColumnWidth(transcript));
    }
    return Math.max(0, available);
  };
  const clampWidth = (value: number) => {
    const available = availableWidth(options());
    return Math.round(Math.max(Math.min(minimumWidth, available), Math.min(available, value)));
  };
  const writable = () => !retired && edge?.isConnected && Boolean(options().onComposerWidthChange);
  const commit = (value: string | undefined) => {
    if (writable()) {
      // The existing settings owner commits synchronously; its render is our acknowledgement.
      lastWidth = value;
      options().onComposerWidthChange?.(value);
    }
  };
  const measure = (current: ComposerWidthOptions) => {
    const host = shell();
    const field = input();
    if (retired || !edge?.isConnected || !host || !field) {
      return;
    }
    const available = availableWidth(current);
    const inputBox = field.getBoundingClientRect();
    const shellBox = host.getBoundingClientRect();
    edge.style.top = `${inputBox.top - shellBox.top + 18}px`;
    edge.style.bottom = `${Math.max(0, shellBox.bottom - inputBox.bottom) + 18}px`;
    const renderedWidth = Math.round(shellBox.width);
    if (refreshMinimum && available >= 480) {
      minimumWidth = Math.min(480, renderedWidth);
      refreshMinimum = false;
    }
    edge.setAttribute("aria-valuenow", String(renderedWidth));
    edge.setAttribute("aria-valuemin", String(Math.min(minimumWidth, available, renderedWidth)));
    edge.setAttribute("aria-valuemax", String(Math.round(available)));
  };
  const schedule = createLayoutMeasurement(
    () => {
      // Read each reactive prop here; callers may return a stable props object.
      const { chatMessageMaxWidth, onComposerWidthChange, getTranscriptElement } = options();
      return { chatMessageMaxWidth, onComposerWidthChange, getTranscriptElement };
    },
    (next) => {
      if (!next) {
        return;
      }
      const width = next.chatMessageMaxWidth ?? undefined;
      if (width !== lastWidth) {
        baseline = width;
        refreshMinimum = true;
      }
      lastWidth = width;
      measure(next);
    },
    {
      targets: (next) =>
        [shell(), input(), shell() && region(), next?.getTranscriptElement?.()].filter(
          (node): node is Element => Boolean(node),
        ),
      changeTiming: "sync",
    },
  );
  onSettled(() => {
    // Native callers can attach after settlement; sample their committed connection too.
    schedule();
    return () => {
      retired = true;
      drag.cancel();
    };
  });
  const startDrag = (event: PointerEvent) => {
    if (!writable() || event.button !== 0 || !event.isPrimary || dragging) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const host = shell()!;
    const root = host.closest<HTMLElement>(".chat, .new-session-page") ?? host.parentElement!;
    const start = host.getBoundingClientRect().width;
    const origin = event.clientX;
    const prior = root.style.getPropertyValue("--chat-thread-max-width");
    let width = start;
    let moved = false;
    const finish = (save: boolean) => {
      dragging = false;
      if (prior) {
        root.style.setProperty("--chat-thread-max-width", prior);
      } else {
        root.style.removeProperty("--chat-thread-max-width");
      }
      if (save && moved && Math.abs(width - start) >= 3) {
        commit(`${width}px`);
      }
    };
    dragging = drag.start(event, edge!, {
      move: (next) => {
        const delta = next.clientX - origin;
        if (!moved && Math.abs(delta) < 3) {
          return;
        }
        moved = true;
        width = clampWidth(start - 2 * delta);
        root.style.setProperty("--chat-thread-max-width", `${width}px`);
      },
      end: () => finish(true),
      cancel: () => finish(false),
    });
  };
  // Inline styles keep this lazy owner's only presentation out of the shared stylesheet.
  // The target sits outside the scroll-clipped input; geometry sets its vertical extent.
  return (
    <div
      ref={(element) => {
        edge = element;
        schedule();
      }}
      class="agent-chat__composer-width-edge"
      style={{
        position: "absolute",
        left: "-8px",
        width: "8px",
        cursor: "ew-resize",
        "touch-action": "none",
      }}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("common.resizeMessageWidth")}
      tabindex="0"
      onPointerDown={startDrag}
      onDblClick={(event) => {
        if (writable()) {
          event.preventDefault();
          event.stopPropagation();
          drag.cancel();
          commit(baseline);
        }
      }}
      onKeyDown={(event) => {
        if (!writable() || event.ctrlKey || event.altKey || event.metaKey || dragging) {
          return;
        }
        if (event.key === "Enter" || event.key === "Home") {
          event.preventDefault();
          commit(baseline);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const current = shell()!.getBoundingClientRect().width;
          const next = clampWidth(current + (event.key === "ArrowLeft" ? 20 : -20));
          if (Math.abs(next - current) >= 1) {
            commit(`${next}px`);
          }
        }
      }}
    />
  );
}
