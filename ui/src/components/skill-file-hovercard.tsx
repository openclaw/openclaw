import type { SkillsFileGetResult } from "@openclaw/gateway-protocol";
import { render, spread } from "@solidjs/web";
import { createEffect, createMemo, Errored, For, Loading, onSettled, Show } from "solid-js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { registerFilePreviewEnglish } from "../i18n/locales/en-file-preview.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { highlightCodeHtml } from "./markdown-code-blocks.ts";
import {
  controlsForHovercard,
  createHovercardControlRef,
  HovercardControlsContext,
} from "./portaled-hovercard-focus.ts";
import { createPortaledHovercard, createPortaledHovercardOwner } from "./portaled-hovercard.ts";
import { CopyButton } from "./solid/copy-button.tsx";
import { Icon } from "./solid/icon.tsx";
import { SanitizedHtml } from "./solid/sanitized-html.tsx";
import "../styles/skill-file-hovercard.css";

registerEnglishCatalog(registerFilePreviewEnglish);

const MAX_PREVIEW_LINES = 400;
let nextId = 0;

type SkillFileHovercardProps = {
  client: GatewayBrowserClient | null;
  agentId?: string;
  sessionKey: string;
  onOpenFile: (file: SkillsFileGetResult, line: number | null) => void;
};

function skillAnchor(event: Event): HTMLAnchorElement | null {
  const anchor =
    event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>("a[data-file-path]")
      : null;
  return anchor && /(?:^|[/\\])SKILL\.md$/i.test(anchor.dataset.filePath ?? "") ? anchor : null;
}

function SkillRead(props: {
  client: GatewayBrowserClient;
  path: string;
  agentId?: string;
  signal: AbortSignal;
  onOpen: (file: SkillsFileGetResult) => void;
  onClose: () => void;
  onPosition: () => void;
}) {
  const file = createMemo(() =>
    props.client.request<SkillsFileGetResult>(
      "skills.files.get",
      { agentId: props.agentId, path: props.path },
      { signal: props.signal },
    ),
  );
  const lines = createMemo(() => {
    const source = file().content.replace(/\r\n/g, "\n").split("\n");
    if (source.at(-1) === "") {
      source.pop();
    }
    return source;
  });
  const preview = createMemo(() => {
    const source = lines();
    const frontmatterEnd = source[0] === "---" ? source.indexOf("---", 1) : -1;
    return source.slice(0, MAX_PREVIEW_LINES).map((line, index) => ({
      number: index + 1,
      html: highlightCodeHtml(line || " ", index <= frontmatterEnd ? "yaml" : "markdown"),
    }));
  });
  onSettled(() => props.onPosition());
  return (
    <>
      <header class="skill-file-hovercard__header">
        <span class="skill-file-hovercard__icon" aria-hidden="true">
          <Icon name="fileText" />
        </span>
        <strong>{file().path.replaceAll("\\", "/").split("/").at(-1)}</strong>
        <span class="skill-file-hovercard__name">{file().name}</span>
        <div class="skill-file-hovercard__actions">
          <CopyButton
            ref={createHovercardControlRef()}
            text={file().content}
            idleLabel={t("filePreview.copyFile")}
            bare
          />
          <button
            ref={createHovercardControlRef()}
            type="button"
            title={t("filePreview.skill.open")}
            aria-label={t("filePreview.skill.open")}
            onClick={() => props.onOpen(file())}
          >
            <Icon name="maximize" />
          </button>
          <button
            ref={createHovercardControlRef()}
            type="button"
            aria-label={t("common.close")}
            onClick={() => props.onClose()}
          >
            <Icon name="x" />
          </button>
        </div>
      </header>
      <div
        ref={createHovercardControlRef()}
        class="skill-file-hovercard__source"
        tabindex={0}
        aria-label={t("filePreview.skill.source")}
      >
        <For each={preview()}>
          {(line) => (
            <div class="skill-file-hovercard__line">
              <span class="skill-file-hovercard__number" aria-hidden="true">
                {line.number}
              </span>
              <SanitizedHtml tag="code" html={line.html} />
            </div>
          )}
        </For>
      </div>
      <footer class="skill-file-hovercard__footer">
        <span class="skill-file-hovercard__path" title={file().path}>
          {file().path}
        </span>
        <span>
          {t("filePreview.skill.lines", {
            count: String(preview().length),
            total: String(lines().length),
          })}
        </span>
      </footer>
    </>
  );
}

function SkillReadStatus(props: {
  retry?: () => void;
  onClose: () => void;
  onPosition: () => void;
}) {
  onSettled(() => props.onPosition());
  return (
    <>
      <header class="skill-file-hovercard__header">
        <strong>{t("filePreview.skill.title")}</strong>
        <div class="skill-file-hovercard__actions">
          <button
            ref={createHovercardControlRef()}
            type="button"
            aria-label={t("common.close")}
            onClick={() => props.onClose()}
          >
            <Icon name="x" />
          </button>
        </div>
      </header>
      <div class="skill-file-hovercard__status" role="status">
        <Show
          when={props.retry}
          fallback={
            <>
              <span class="session-run-spinner" aria-hidden="true" />
              {t("filePreview.skill.loading")}
            </>
          }
        >
          <Icon name="alertTriangle" />
          <strong>{t("filePreview.skill.unavailable")}</strong>
          <span>{t("filePreview.skill.unavailableHint")}</span>
          <button
            ref={createHovercardControlRef()}
            type="button"
            class="btn btn--sm"
            onClick={() => props.retry?.()}
          >
            {t("common.retry")}
          </button>
        </Show>
      </div>
    </>
  );
}

/** Delegates transcript intent while the shared hovercard owns its portal and focus. */
export function createSkillFileHovercard(props: SkillFileHovercardProps) {
  let host: HTMLElement | undefined;
  let anchor: HTMLAnchorElement | null = null;
  let request: AbortController | null = null;
  let pointerOpened = false;
  const hovercard = createPortaledHovercardOwner(close);
  const scope = createMemo(() => [props.client, props.agentId, props.sessionKey] as const, {
    equals: (previous, next) => previous.every((value, index) => value === next[index]),
  });
  createEffect(scope, close);

  function close() {
    request?.abort();
    request = null;
    hovercard.reset();
    anchor = null;
    pointerOpened = false;
  }
  function dismiss() {
    const trigger = anchor;
    close();
    hovercard.returnFocus(trigger);
  }
  function activate(next: HTMLAnchorElement, delay: number) {
    const client = props.client;
    const path = next.dataset.filePath;
    if (!client || !path || next === anchor) {
      return;
    }
    close();
    anchor = next;
    const agentId = props.agentId;
    hovercard.markTrigger(next);
    hovercard.scheduleOpen(delay, () => {
      const controller = new AbortController();
      request = controller;
      const card = createPortaledHovercard(
        `skill-file-preview-${++nextId}`,
        "skill-file-hovercard",
      );
      const stopLeave = listen(card, "pointerleave", () => {
        if (pointerOpened) {
          hovercard.cardFocusInside = false;
        }
        hovercard.handleCardPointerLeave();
      });
      const stopOutside = listen(
        document,
        "pointerdown",
        (event) => {
          if (
            event.target instanceof Node &&
            !next.contains(event.target) &&
            !card.contains(event.target)
          ) {
            close();
          }
        },
        true,
      );
      const stopEscape = listen(
        document,
        "keydown",
        (event) => {
          if (event instanceof KeyboardEvent && event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (card.contains(document.activeElement)) {
              dismiss();
            } else {
              close();
            }
          }
        },
        true,
      );
      // Mount can retire an ineligible trigger before its Solid root exists.
      let dispose: (() => void) | undefined = undefined;
      hovercard.mount(next, card, "vertical", true, () => {
        stopLeave();
        stopOutside();
        stopEscape();
        dispose?.();
      });
      if (hovercard.card !== card) {
        return;
      }
      dispose = render(() => {
        spread(card, () => ({ "aria-label": t("filePreview.skill.title") }), true);
        return (
          <HovercardControlsContext value={controlsForHovercard(card)}>
            <Errored
              fallback={(_error, retry) => (
                <SkillReadStatus
                  retry={retry}
                  onClose={dismiss}
                  onPosition={() => hovercard.position()}
                />
              )}
            >
              <Loading
                fallback={
                  <SkillReadStatus onClose={dismiss} onPosition={() => hovercard.position()} />
                }
              >
                <SkillRead
                  client={client}
                  path={path}
                  agentId={agentId}
                  signal={controller.signal}
                  onOpen={(file) => {
                    props.onOpenFile(file, Number(next.dataset.fileLine) || null);
                    close();
                  }}
                  onClose={dismiss}
                  onPosition={() => hovercard.position()}
                />
              </Loading>
            </Errored>
          </HovercardControlsContext>
        );
      }, card);
    });
  }
  function onPointerOver(event: PointerEvent) {
    const target = skillAnchor(event);
    if (!target || event.pointerType === "touch") {
      return;
    }
    activate(target, 250);
    pointerOpened = true;
    hovercard.pointerInside = true;
    hovercard.clearClose();
  }
  function onPointerOut(event: PointerEvent) {
    if (
      skillAnchor(event) === anchor &&
      !(event.relatedTarget instanceof Node && anchor?.contains(event.relatedTarget))
    ) {
      hovercard.schedulePointerExit();
    }
  }
  function onFocusIn(event: FocusEvent) {
    const target = skillAnchor(event);
    if (target && !hovercard.restoringFocus) {
      activate(target, 0);
      hovercard.focusInside = true;
    }
  }
  function onFocusOut() {
    hovercard.focusInside = false;
    hovercard.scheduleClose();
  }
  function onClick(event: MouseEvent) {
    const target = skillAnchor(event);
    if (target && props.client) {
      event.preventDefault();
      event.stopPropagation();
      activate(target, 0);
      hovercard.explicitHold = true;
    }
  }
  function onKeyDown(event: KeyboardEvent) {
    const target = skillAnchor(event);
    if (target && props.client && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      event.stopPropagation();
      activate(target, 0);
      hovercard.explicitHold = true;
    } else if (anchor) {
      hovercard.handleTriggerKeyDown(event);
    }
  }
  onSettled(() => {
    if (!host) {
      return undefined;
    }
    const stops = [
      listen(host, "pointerover", { handleEvent: onPointerOver }),
      listen(host, "pointerout", { handleEvent: onPointerOut }),
      listen(host, "focusin", { handleEvent: onFocusIn }),
      listen(host, "focusout", onFocusOut),
      listen(host, "keydown", { handleEvent: onKeyDown }, true),
      // Installed skill paths can be outside the workspace. Capture before its file handler.
      listen(host, "click", { handleEvent: onClick }, true),
    ];
    return () => {
      stops.forEach((stop) => stop());
      close();
    };
  });
  return (element: HTMLElement) => {
    host = element;
  };
}
