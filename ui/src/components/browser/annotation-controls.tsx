import { For, Show } from "solid-js";
import { registerBrowserEnglish } from "../../i18n/locales/en-browser.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { Icon } from "../solid/icon.tsx";
import type { BrowserInspectedNode } from "./browser-client.ts";
import "./annotation-controls.css";

registerEnglishCatalog(registerBrowserEnglish);

/** Shared capture actions: adding stages a comment, never sends a chat turn. */
export function AnnotationBar(props: {
  hasMarks: boolean;
  onUndo: () => void;
  onClear: () => void;
  onExit: () => void;
  onAdd: () => void;
}) {
  return (
    <div class="bp-annotatebar">
      <span class="bp-annotatebar__hint">{t("browser.annotateHint")}</span>
      <For each={["undo", "clear"] as const}>
        {(action) => (
          <button
            class="bp-btn"
            type="button"
            disabled={!props.hasMarks}
            onClick={() => (action === "undo" ? props.onUndo() : props.onClear())}
          >
            {t(action === "undo" ? "browser.annotateUndo" : "browser.annotateClear")}
          </button>
        )}
      </For>
      <button
        class="bp-btn"
        type="button"
        title={t("browser.annotateDone")}
        aria-label={t("browser.annotateDone")}
        onClick={() => props.onExit()}
      >
        <Icon name="x" />
      </button>
      <button
        class="bp-btn bp-btn--primary"
        type="button"
        disabled={!props.hasMarks}
        onClick={() => props.onAdd()}
      >
        {t("browser.annotateSend")}
      </button>
    </div>
  );
}

export function AnnotationTooltip(props: {
  node: BrowserInspectedNode | null;
  pointer: { x: number; y: number } | null;
}) {
  return (
    <Show when={props.node && props.pointer}>
      <div
        class="bp-tooltip"
        style={{
          left: `${Math.min(92, Math.max(0, props.pointer!.x * 100))}%`,
          top: `${Math.min(92, Math.max(0, props.pointer!.y * 100 + 2))}%`,
        }}
      >
        <div class="bp-tooltip__title">
          <span class="bp-tooltip__selector">
            {props.node!.tag}
            {props.node!.id ? `#${props.node!.id}` : ""}
            {props.node!.classes.map((name) => `.${name}`).join("")}
          </span>
          <span class="bp-tooltip__size">
            {Math.round(props.node!.rect.width)} × {Math.round(props.node!.rect.height)}
          </span>
        </div>
        <Show when={props.node!.name}>
          <div class="bp-tooltip__row">
            <span>{t("browser.inspectName")}</span>
            <span>{props.node!.name}</span>
          </div>
        </Show>
        <Show when={props.node!.role}>
          <div class="bp-tooltip__row">
            <span>{t("browser.inspectRole")}</span>
            <span>{props.node!.role}</span>
          </div>
        </Show>
        <div class="bp-tooltip__row">
          <span>{t("browser.inspectFocusable")}</span>
          <span>{props.node!.focusable ? "✓" : "–"}</span>
        </div>
      </div>
    </Show>
  );
}
