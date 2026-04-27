export function buildTextEmbeddingInput(text) {
    return { text };
}
export function isInlineDataEmbeddingInputPart(part) {
    return part.type === "inline-data";
}
export function hasNonTextEmbeddingParts(input) {
    if (!input?.parts?.length) {
        return false;
    }
    return input.parts.some((part) => isInlineDataEmbeddingInputPart(part));
}
