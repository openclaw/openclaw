import type { JSX } from "@solidjs/web";
import { children, createEffect, createMemo, onCleanup, onSettled, Show, untrack } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import "../../styles/debug.css";
import { t } from "../../lib/reactive/i18n.ts";
import type { DebugOverlayLayout } from "./debug-overlay-layout.runtime.ts";
import type { DebugOverlayMode } from "./debug-overlay-state.ts";

export function DebugOverlayFrame(props: {
  mode: DebugOverlayMode;
  body: JSX.Element;
  onToggleMode: () => void;
  onClose: () => void;
}) {
  const body = children(() => props.body);
  let element!: HTMLElement;
  let layout: DebugOverlayLayout | undefined;
  let disposed = false;
  // Capture the previous box before Solid applies the new mode's class.
  const mode = createMemo(() => {
    layout?.update(props.mode);
    return props.mode;
  });
  onSettled(() => {
    void import("./debug-overlay-layout.runtime.ts")
      .then(({ DebugOverlayLayout }) => {
        if (disposed || !element.isConnected) {
          return;
        }
        layout = new DebugOverlayLayout(element);
        layout.update(untrack(mode));
      })
      .catch((error: unknown) =>
        console.error("System busyness position controls could not load. Reload to retry.", error),
      );
  });
  createEffect(body, () => layout?.update(untrack(mode)));
  onCleanup(() => {
    disposed = true;
    layout?.disconnect();
  });
  return (
    <aside
      ref={(node) => {
        element = node;
      }}
      class={["debug-overlay", { "debug-overlay--minimized": mode() === "minimized" }]}
      aria-label={t("debug.overlay.title")}
    >
      <header
        class="debug-overlay__header"
        role="group"
        tabindex={0}
        aria-label={t("debug.overlay.move")}
      >
        <div>
          <Show when={mode() !== "minimized"}>
            <div class="debug-overlay__eyebrow">{t("debug.overlay.eyebrow")}</div>
          </Show>
          <h2>{t("debug.overlay.title")}</h2>
        </div>
        <div class="debug-overlay__controls">
          <button
            type="button"
            class="debug-overlay__control"
            aria-label={t(
              mode() === "minimized" ? "debug.overlay.expand" : "debug.overlay.minimize",
            )}
            title={t(mode() === "minimized" ? "debug.overlay.expand" : "debug.overlay.minimize")}
            onClick={() => props.onToggleMode()}
          >
            <Icon name={mode() === "minimized" ? "maximize" : "minimize"} />
          </button>
          <button
            type="button"
            class="debug-overlay__control debug-overlay__close"
            aria-label={t("common.close")}
            onClick={() => props.onClose()}
          >
            <Icon name="x" />
          </button>
        </div>
      </header>
      <div class="debug-overlay__body">{body()}</div>
    </aside>
  );
}
