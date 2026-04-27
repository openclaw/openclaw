const INLINE_HORIZONTAL_WHITESPACE_RE = /[^\S\n]+/g;
export function collapseInlineHorizontalWhitespace(value) {
    return value.replace(INLINE_HORIZONTAL_WHITESPACE_RE, " ");
}
