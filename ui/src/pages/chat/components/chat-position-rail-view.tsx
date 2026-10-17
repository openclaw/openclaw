import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { For, Show, createMemo, onCleanup, untrack } from "solid-js";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { AgentIdentityAvatar } from "../../../components/solid/identity-avatar.tsx";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar.ts";
import { MarkdownContent } from "./chat-message-text-view.tsx";
import type { ChatPositionIndex } from "./chat-position-projection.ts";
import { POSITION_RAIL_MARKER_HEIGHT } from "./chat-transcript-geometry.ts";

const PREVIEW_LENGTH = 140;

export function syncPositionRailVisibility(
  scroller: HTMLElement | undefined,
  overflowing: boolean,
): boolean {
  const rail = scroller?.closest<HTMLElement>(".chat-position-rail");
  if (!rail || rail.hasAttribute("data-overflow") === overflowing) {
    return false;
  }
  // A resize can make the whole conversation fit while its rail has focus.
  if (!overflowing && rail.contains(rail.ownerDocument.activeElement)) {
    rail.closest<HTMLElement>(".chat-thread")?.focus({ preventScroll: true });
  }
  rail.toggleAttribute("data-overflow", overflowing);
  return true;
}

export function syncPositionRailTabStop(
  markers: Iterable<HTMLElement>,
  tabStop: HTMLElement | undefined,
): void {
  const previousTabStop = [...markers].find((marker) => marker.tabIndex === 0);
  if (tabStop && tabStop !== previousTabStop) {
    if (previousTabStop) {
      previousTabStop.tabIndex = -1;
    }
    tabStop.tabIndex = 0;
  }
}

export function syncPositionRailPreview(
  preview: HTMLElement | undefined,
  marker: HTMLElement | undefined,
  center: number,
  viewportHeight: number,
): void {
  if (!preview || !marker) {
    return;
  }
  const label = preview.querySelector(".chat-position-rail__preview-label")?.textContent?.trim();
  const copy = preview.querySelector(".chat-position-rail__preview-copy")?.textContent?.trim();
  const description = `${label ?? ""} ${copy ?? ""}. ${t("chat.thread.positionMarkerHint")}`;
  if (marker.getAttribute("aria-description") !== description) {
    marker.setAttribute("aria-description", description);
  }
  preview.style.setProperty("--chat-position-preview", `${center}px`);
  preview.style.visibility = center < 0 || center > viewportHeight ? "hidden" : "";
}

export type PositionRailAssistant = {
  id: string;
  name: string;
  avatar: string | null;
  textAvatar: string | null;
};

export type PositionRailViewParams = {
  assistant?: PositionRailAssistant;
  markers: Readonly<ChatPositionIndex["markers"]>;
  renderedIndexes: readonly number[];
  activeId: string | undefined;
  visibleIds: ReadonlySet<string>;
  rovingId: string;
  previewId: string | null | undefined;
  hoveredId: string | null;
  createMarkerRef: (id: string) => (element: HTMLButtonElement) => void;
  bindScroller: (element?: Element) => void;
  bindPreview: (element?: Element) => void;
  onScroll: () => void;
  stopScrollInput: EventListenerObject & AddEventListenerOptions;
  onPointerLeave: () => void;
  onMarkerHover: (id: string) => void;
  onMarkerFocus: (id: string, event: FocusEvent) => void;
  onMarkerBlur: () => void;
  onMarkerKeyDown: (index: number, event: KeyboardEvent) => void;
  onMarkerSelect: (anchorId: string) => void;
};

/** Presentation only; the rail owner manages windowing, interaction, and DOM lifetime. */
export function ChatPositionRailView(props: PositionRailViewParams) {
  // Ref factories belong to the rail lifetime, independent of refreshed view snapshots.
  const createMarkerRef = untrack(() => props.createMarkerRef);
  const bindScroller = untrack(() => props.bindScroller);
  const bindPreview = untrack(() => props.bindPreview);
  const assistantLabel = () =>
    props.assistant?.name.trim() || t("chat.thread.positionAssistantMessage");
  const markerLabel = (marker: ChatPositionIndex["markers"][number]) =>
    marker.role === "user" ? t("chat.thread.positionUserMessage") : assistantLabel();
  const entries = createMemo(() =>
    props.renderedIndexes.map((index, renderedIndex) => ({
      index,
      marker: props.markers[index]!,
      separated: renderedIndex > 0 && index > props.renderedIndexes[renderedIndex - 1]! + 1,
    })),
  );
  const previewMarker = createMemo(() =>
    props.previewId == null
      ? undefined
      : props.markers.find((marker) => marker.id === props.previewId),
  );
  const previewMessage = createMemo(() => {
    const marker = previewMarker();
    return marker ? normalizeMessage(marker.message) : undefined;
  });
  const previewSender = () =>
    previewMessage()?.role === "user" ? previewMessage()?.sender : undefined;
  const previewLabel = () =>
    (previewSender() ? previewMessage()?.senderLabel : null) ??
    (previewMarker() ? markerLabel(previewMarker()!) : undefined);
  const previewHtml = createMemo(() => {
    const marker = previewMarker();
    const message = previewMessage();
    const text =
      marker && message
        ? truncateUtf16Safe(
            resolveMessageDisplayMarkdown(marker.message, message).trim(),
            PREVIEW_LENGTH,
          )
        : "";
    return text ? toSanitizedMarkdownHtml(text, { codeBlockChrome: "none" }) : "";
  });
  const stopScrollInput = (event: Event) => props.stopScrollInput.handleEvent(event);
  let stopInput: (() => void)[] = [];
  const bindInputScroller = (element: HTMLDivElement) => {
    bindScroller(element);
    // Stop touch input here, before the transcript's native history listeners.
    stopInput = ["wheel", "touchstart", "touchmove"].map((type) =>
      listen(element, type, stopScrollInput, { passive: true }),
    );
  };
  onCleanup(() => stopInput.forEach((stop) => stop()));
  const Preview = () => {
    onCleanup(() => bindPreview());
    return (
      <div ref={bindPreview} class="chat-position-rail__preview" aria-hidden="true">
        <div class="chat-position-rail__preview-header">
          <Show
            when={previewMarker()?.role === "assistant" && props.assistant}
            fallback={<ChatAuthorAvatar sender={previewSender()} />}
          >
            <span class="chat-author-avatar" role="img" aria-label={assistantLabel()}>
              <AgentIdentityAvatar agent={props.assistant!} />
            </span>
          </Show>
          <span class="chat-position-rail__preview-label">{previewLabel()}</span>
        </div>
        {/* Preview links stay inert; the marker owns keyboard navigation. */}
        <div class="chat-position-rail__preview-copy" inert>
          <Show when={Boolean(previewHtml())} fallback={t("chat.attachments.previewUnavailable")}>
            <MarkdownContent content={previewHtml()} />
          </Show>
        </div>
      </div>
    );
  };
  return (
    <aside
      class="chat-position-rail"
      style={{ "--chat-position-rail-count": props.markers.length }}
      aria-label={t("chat.thread.positionRail")}
      onPointerLeave={() => props.onPointerLeave()}
    >
      <div class="chat-position-rail__track">
        <div
          ref={bindInputScroller}
          class="chat-position-rail__marks"
          role="list"
          aria-label={t("chat.thread.positionRail")}
          onScroll={() => props.onScroll()}
        >
          <div class="chat-position-rail__virtual-space">
            <For each={entries()} keyed={(entry) => entry.marker.id}>
              {(entry) => {
                // The For key fixes this marker's identity for its owner.
                const markerRef = createMarkerRef(untrack(() => entry().marker.id));
                return (
                  <>
                    <Show when={entry().separated}>
                      <div aria-hidden="true" />
                    </Show>
                    <div
                      class="chat-position-rail__item"
                      data-hovered={entry().marker.id === props.hoveredId ? "" : undefined}
                      role="listitem"
                      aria-posinset={entry().index + 1}
                      aria-setsize={props.markers.length}
                    >
                      <button
                        ref={markerRef}
                        class="chat-position-rail__marker"
                        style={{ top: `${entry().index * POSITION_RAIL_MARKER_HEIGHT}px` }}
                        type="button"
                        data-position-marker-id={entry().marker.id}
                        tabindex={entry().marker.id === props.rovingId ? 0 : -1}
                        aria-label={t("chat.thread.positionMarker", {
                          position: String(entry().index + 1),
                          count: String(props.markers.length),
                          label: markerLabel(entry().marker),
                        })}
                        aria-description={t("chat.thread.positionMarkerHint")}
                        aria-current={entry().marker.id === props.activeId ? "true" : "false"}
                        data-visible={props.visibleIds.has(entry().marker.id) ? "" : undefined}
                        onPointerEnter={() => props.onMarkerHover(entry().marker.id)}
                        onFocus={(event) => props.onMarkerFocus(entry().marker.id, event)}
                        onBlur={() => props.onMarkerBlur()}
                        onKeyDown={(event) => props.onMarkerKeyDown(entry().index, event)}
                        onClick={() => props.onMarkerSelect(entry().marker.anchorId)}
                      >
                        <span class="chat-position-rail__tick" aria-hidden="true" />
                      </button>
                    </div>
                  </>
                );
              }}
            </For>
          </div>
        </div>
        <Show when={previewMarker()}>
          <Preview />
        </Show>
      </div>
    </aside>
  );
}
