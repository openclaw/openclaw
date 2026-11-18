export const WIDGET_COMMENT_INTENT = "openclaw-widget-comment-intent";

export type WidgetCommentEditorScope = {
  signal: AbortSignal;
  current: () => boolean;
  onCancel: () => void;
};

export type WidgetCommentIntent = WidgetCommentEditorScope & { text: string; anchor: DOMRect };
