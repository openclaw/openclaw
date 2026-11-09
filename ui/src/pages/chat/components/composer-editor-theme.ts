import { EditorView } from "@codemirror/view";

// The lazy editor owns its document styles; responsive frame rules stay with the composer.
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
  },
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
    caretColor: "var(--text-strong)",
  },
  ".chat-composer-mention": { whiteSpace: "nowrap" },
  ".chat-composer-mention .markdown-person-reference__avatar": {
    userSelect: "text",
    WebkitUserSelect: "text",
  },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--muted)" },
});
