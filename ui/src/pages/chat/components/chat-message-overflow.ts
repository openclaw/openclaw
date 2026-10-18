import { findMessageDisclosureLine, type MessageTextRect } from "./chat-message-disclosure.ts";

// Character length owns normal disclosure; this high line cap only bounds newline-heavy prompts.
const USER_MESSAGE_COLLAPSED_CHAR_LIMIT = 1_200;
const USER_MESSAGE_COLLAPSED_LINE_LIMIT = 40;
const USER_MESSAGE_PREVIEW_LINES = 5;
const MESSAGE_PREVIEW_FADE_START_FRACTION = 0.24;

export function shouldCollapseUserMessage(markdown: string): boolean {
  return (
    markdown.length > USER_MESSAGE_COLLAPSED_CHAR_LIMIT ||
    markdown.split("\n", USER_MESSAGE_COLLAPSED_LINE_LIMIT + 1).length >
      USER_MESSAGE_COLLAPSED_LINE_LIMIT
  );
}

const FORWARDED_MESSAGE_COLLAPSE_LINE_LIMIT = 3;

type MessageOverflowMeasurement = {
  element: HTMLElement;
  read: () => (() => void) | undefined;
};
const pendingOverflowMeasurements = new Set<MessageOverflowMeasurement>();
let overflowMeasurementQueued = false;

function scheduleOverflowMeasurement(measurement: MessageOverflowMeasurement): void {
  pendingOverflowMeasurements.add(measurement);
  if (overflowMeasurementQueued) {
    return;
  }
  overflowMeasurementQueued = true;
  queueMicrotask(() => {
    overflowMeasurementQueued = false;
    const measurements = [...pendingOverflowMeasurements];
    pendingOverflowMeasurements.clear();
    // Restore every full preview before reading layout, then apply every cut.
    // Interleaving these phases forces a separate page layout for each message.
    for (const entry of measurements) {
      entry.element.style.removeProperty("--chat-disclosure-clamp");
    }
    const updates = measurements.map((entry) => entry.read());
    for (const update of updates) {
      update?.();
    }
  });
}

export function messageOverflowRef(expanded: boolean, forwarded: boolean) {
  let resizeObserver: ResizeObserver | null = null;
  let onFontsLoaded: (() => void) | undefined;
  let measurement: MessageOverflowMeasurement | undefined;
  let generation = 0;
  return (element: Element | undefined) => {
    const currentGeneration = ++generation;
    if (measurement) {
      pendingOverflowMeasurements.delete(measurement);
      measurement = undefined;
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (onFontsLoaded) {
      document.fonts?.removeEventListener("loadingdone", onFontsLoaded);
      onFontsLoaded = undefined;
    }
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const read = () => {
      if (generation !== currentGeneration) {
        return undefined;
      }
      const disclosure = element.parentElement;
      const toggle = disclosure?.querySelector<HTMLButtonElement>(
        ":scope > .chat-message-disclosure__toggle",
      );
      if (!disclosure || !toggle) {
        return undefined;
      }
      let clamp: string | undefined;
      let fadeSize: string | undefined;
      const text = element.querySelector<HTMLElement>(":scope > .chat-text");
      // Test the full preview before a partial-line cut can create its own overflow.
      const scrollHeight = element.scrollHeight;
      const overflows = scrollHeight > element.clientHeight + 1;
      if (!forwarded && !expanded && overflows && text && element.clientWidth > 0) {
        const origin = element.getBoundingClientRect().top - element.scrollTop;
        const defaultLineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
        const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        const rects: MessageTextRect[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (
            !node.textContent?.trim() ||
            !node.parentElement?.checkVisibility() ||
            // Escaped HTML can be direct body text; the closed details itself stays visible.
            node.parentElement.matches("details:not([open])")
          ) {
            continue;
          }
          const lineHeight =
            Number.parseFloat(getComputedStyle(node.parentElement).lineHeight) || defaultLineHeight;
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            // Range bounds cover glyphs; account for the line's rounded half-leading.
            const leading = Math.floor((lineHeight - rect.height) / 2);
            rects.push({
              top: rect.top - origin - leading,
              glyphTop: rect.top - origin,
              bottom: rect.bottom - origin - leading,
              width: rect.width,
              lineHeight,
            });
          }
        }
        // Native fallback summaries live in a closed shadow tree, outside the text walker.
        for (const details of text.querySelectorAll("details:not(:has(> summary))")) {
          if (!details.checkVisibility()) {
            continue;
          }
          const style = getComputedStyle(details);
          const lineHeight = Number.parseFloat(style.lineHeight) || defaultLineHeight;
          const bounds = details.getBoundingClientRect();
          const top =
            bounds.top -
            origin +
            Number.parseFloat(style.borderTopWidth) +
            Number.parseFloat(style.paddingTop);
          rects.push({
            top,
            glyphTop: top,
            bottom: top + lineHeight,
            width: bounds.width,
            lineHeight,
          });
        }
        const lastLine = findMessageDisclosureLine(rects, USER_MESSAGE_PREVIEW_LINES);
        if (lastLine) {
          clamp = `${lastLine.clamp}px`;
          fadeSize = `${lastLine.clamp - lastLine.top - lastLine.lineHeight * MESSAGE_PREVIEW_FADE_START_FRACTION}px`;
        }
      }
      const hidden =
        !expanded &&
        (forwarded && text
          ? scrollHeight <=
            Number.parseFloat(getComputedStyle(text).lineHeight) *
              FORWARDED_MESSAGE_COLLAPSE_LINE_LIMIT +
              1
          : !overflows);
      return () => {
        if (generation !== currentGeneration) {
          return;
        }
        for (const [property, value] of [
          ["--chat-disclosure-clamp", clamp],
          ["--chat-disclosure-fade-size", fadeSize],
        ] as const) {
          if (value === undefined) {
            element.style.removeProperty(property);
          } else if (element.style.getPropertyValue(property) !== value) {
            element.style.setProperty(property, value);
          }
        }
        toggle.hidden = hidden;
      };
    };
    const currentMeasurement = (measurement = { element, read });
    const update = () => {
      if (generation === currentGeneration) {
        scheduleOverflowMeasurement(currentMeasurement);
      }
    };
    // Lit resolves refs while siblings are still committing. Measure after the
    // toggle exists; it renders visible so collapsing never shifts row height,
    // and only content that fits the clamp hides it.
    queueMicrotask(() => {
      if (generation !== currentGeneration) {
        return;
      }
      const text = element.querySelector(":scope > .chat-text");
      if (text) {
        resizeObserver?.observe(text);
      }
    });
    update();
    // Font metrics can change without resizing tightly spaced text, including
    // fonts loaded after this retained message's original render.
    onFontsLoaded = update;
    document.fonts?.addEventListener("loadingdone", onFontsLoaded);
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(update);
      resizeObserver.observe(element);
    }
  };
}
