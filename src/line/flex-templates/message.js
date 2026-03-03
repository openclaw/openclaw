/**
 * Wrap a FlexContainer in a FlexMessage
 */
export function toFlexMessage(altText, contents) {
    return {
        type: "flex",
        altText,
        contents,
    };
}
