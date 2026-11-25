import {
  WIDGET_THEME_MESSAGE_TYPE,
  WIDGET_THEME_TOKENS,
  type WidgetThemeMessage,
  type WidgetThemeToken,
} from "../../../src/shared/widget-theme.ts";
import { listen } from "./reactive/listener.ts";

const HOST_TOKEN_SOURCES: Record<WidgetThemeToken, string> = {
  surface: "--bg",
  card: "--card",
  elevated: "--bg-elevated",
  text: "--text",
  "text-strong": "--text-strong",
  muted: "--muted",
  border: "--border",
  "border-strong": "--border-strong",
  accent: "--accent",
  "accent-fill": "--primary",
  "accent-fg": "--primary-foreground",
  ok: "--ok",
  warn: "--warn",
  danger: "--danger",
  info: "--info",
  radius: "--radius",
  "radius-full": "--radius-full",
  "scrollbar-size": "--scrollbar-size",
  "scrollbar-thumb-inset": "--scrollbar-thumb-inset",
  "scrollbar-thumb": "--scrollbar-thumb",
  "scrollbar-thumb-hover": "--scrollbar-thumb-hover",
  "font-body": "--font-body",
  "font-mono": "--mono",
};

type WidgetThemeState = {
  message?: WidgetThemeMessage;
  revision?: string;
  frames: Map<HTMLIFrameElement, string>;
};
const widgetThemes = new WeakMap<HTMLElement, WidgetThemeState>();

function isStylesheet(node: Node | null): boolean {
  return node instanceof Element && node.matches('style, link[rel~="stylesheet"]');
}

function changesStylesheet(record: MutationRecord): boolean {
  return (
    isStylesheet(record.target) ||
    (record.type === "characterData" && isStylesheet(record.target.parentNode)) ||
    [...record.addedNodes, ...record.removedNodes].some(isStylesheet)
  );
}

export function buildWidgetThemeMessage(): WidgetThemeMessage {
  const root = document.documentElement;
  const state = widgetThemeState(root);
  // Reads in the same task as a theme change precede MutationObserver delivery.
  const revision = JSON.stringify([
    root.dataset.theme,
    root.dataset.themeMode,
    root.getAttribute("style"),
  ]);
  if (state.message && state.revision === revision) {
    return state.message;
  }
  const styles = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const token of WIDGET_THEME_TOKENS) {
    const value = styles.getPropertyValue(HOST_TOKEN_SOURCES[token]).trim();
    if (value) {
      tokens[token] = value;
    }
  }
  state.revision = revision;
  state.message = {
    type: WIDGET_THEME_MESSAGE_TYPE,
    mode: root.dataset.themeMode === "light" ? "light" : "dark",
    tokens,
  };
  return state.message;
}

export function postWidgetTheme(frame: HTMLIFrameElement, targetOrigin = "*"): void {
  const message = buildWidgetThemeMessage();
  frame.style.colorScheme = message.mode;
  frame.contentWindow?.postMessage(message, targetOrigin);
}

/** Explicit registration also reaches widgets inside a chat component's shadow root. */
export function registerWidgetThemeFrame(frame: HTMLIFrameElement, origin: string): () => void {
  const frames = widgetThemeState(document.documentElement).frames;
  frames.set(frame, origin);
  return () => frames.delete(frame);
}

function widgetThemeState(root: HTMLElement): WidgetThemeState {
  const existing = widgetThemes.get(root);
  if (existing) {
    return existing;
  }
  const state: WidgetThemeState = { frames: new Map() };
  widgetThemes.set(root, state);
  const publish = () => {
    for (const [frame, origin] of state.frames) {
      if (frame.isConnected) {
        postWidgetTheme(frame, origin);
      }
    }
  };
  const observer = new MutationObserver((records) => {
    const stylesheetChanged = records.some(changesStylesheet);
    if (stylesheetChanged) {
      state.message = undefined;
    }
    if (stylesheetChanged || records.some((record) => record.target === root)) {
      publish();
    }
  });
  observer.observe(root, {
    attributes: true,
    // "style" carries the accent override (inline custom properties on <html>);
    // without it a user accent change would only reach frames incidentally.
    attributeFilter: ["data-theme", "data-theme-mode", "style"],
  });
  // Custom palettes replace style text; plugin activation changes link media.
  const head = root.ownerDocument.head;
  observer.observe(head, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["href", "rel", "media", "disabled"],
  });
  // This singleton shares the document root's lifetime with its stylesheet observer.
  listen(
    head,
    "load",
    (event) => {
      if (event.target instanceof HTMLLinkElement && isStylesheet(event.target)) {
        state.message = undefined;
        publish();
      }
    },
    true,
  );
  return state;
}
