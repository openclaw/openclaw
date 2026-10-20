import { createEffect, createMemo, createSignal } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import type { NewSessionComposerTextarea } from "./composer-textarea.ts";

/** Animation belongs to the mounted input; menu and draft updates do not restart it. */
export function createComposerPlaceholder(
  options: () => {
    nativeTerminal?: boolean;
    message: string;
    dictationActive?: boolean;
  },
  textarea: Pick<NewSessionComposerTextarea, "getTextarea">,
) {
  const target = createMemo(() =>
    t(
      options().nativeTerminal
        ? "newSession.nativeTerminalPrompt"
        : "newSession.messagePlaceholder",
    ),
  );
  const hasMessage = createMemo(() => options().message.length > 0);
  const reducedMotion =
    !globalThis.requestAnimationFrame ||
    (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const [frame, setFrame] = createSignal({ target: "", text: "" });
  let entered = false;
  // Restart the browser animation only when its text changes; typing cancels pending frames.
  createEffect(
    () => [target(), hasMessage()] as const,
    ([text, hasText]) => {
      entered ||= hasText;
      if (entered || reducedMotion) {
        return undefined;
      }
      let startedAt: number | undefined;
      let pending: number;
      let length = 0;
      const step = (timestamp: number) => {
        if (!textarea.getTextarea()?.isConnected) {
          return;
        }
        startedAt ??= timestamp;
        const nextLength = Math.min(
          text.length,
          Math.floor(Math.max(0, timestamp - startedAt - 180) / 26),
        );
        entered = nextLength === text.length;
        if (length !== nextLength) {
          length = nextLength;
          setFrame({ target: text, text: text.slice(0, length) });
        }
        if (!entered) {
          pending = requestAnimationFrame(step);
        }
      };
      pending = requestAnimationFrame(step);
      return () => cancelAnimationFrame(pending);
    },
  );
  return () =>
    options().dictationActive
      ? ""
      : entered || hasMessage() || reducedMotion
        ? target()
        : frame().target === target()
          ? frame().text
          : "";
}
