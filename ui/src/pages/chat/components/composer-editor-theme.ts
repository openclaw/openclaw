import { EditorView } from "@codemirror/view";

// The lazy editor owns its document styles. Geometry it shares with the textarea
// lists the editor in the composer stylesheet's own selectors.
// Mirrors the textarea's WebKit scrollbar rules: the same inset becomes the gutter.
const webkitScrollbar = CSS.supports("selector(::-webkit-scrollbar)");
export const composerEditorTheme = EditorView.theme({
  "&": {
    outline: "none",
    cursor: "text",
    overflow: "hidden",
    fontFamily: "inherit",
    width: "100%",
    minHeight: "calc(var(--chat-composer-editor-line) + 8px)",
    maxHeight:
      "min(var(--chat-composer-editor-height-limit, 25dvh), var(--chat-composer-editor-line) * var(--chat-composer-editor-max-lines, 6) + var(--chat-composer-editor-inset-block) * 2)",
    paddingBlock: "var(--chat-composer-editor-inset-block)",
    paddingInline:
      "calc(var(--chat-composer-editor-inset-inline) - var(--chat-composer-editor-scroll-inset))",
    border: "none",
    background: "transparent",
    color: "var(--text-strong)",
    fontSize: "var(--chat-composer-editor-size)",
    lineHeight: "var(--chat-composer-editor-line)",
    ...(webkitScrollbar && { "--scrollbar-size": "8px", "--scrollbar-thumb-inset": "1px" }),
  },
  ...(webkitScrollbar && {
    "&[data-composer-overflow]": {
      paddingInlineEnd: "calc(var(--chat-composer-editor-inset-inline) - var(--scrollbar-size))",
    },
  }),
  // Enter before the session is ready keeps the draft, dimmed, until it sends.
  ".agent-chat__input--submit-queued &": { color: "var(--muted)" },
  "&.cm-focused": { outline: "none" },
  "&.chat-composer-editor--disabled": { opacity: "0.5", cursor: "default" },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "inherit",
    minHeight: "0",
    overflow: "auto",
    scrollbarWidth: "thin",
  },
  ".cm-content": {
    padding: "0",
    minHeight: "1lh",
    font: "inherit",
  },
  ".cm-cursor": { borderLeftColor: "var(--text-strong)" },
  "&.cm-focused .cm-selectionBackground": { backgroundColor: "var(--selection-bg)" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--muted)" },
});
