import type { MessageEntity } from "@grammyjs/types";

/**
 * Merge Telegram message entities from multiple text fragments,
 * adjusting offsets so they remain correct in the concatenated text.
 *
 * @param fragments - Array of `{ text, entities }` in order.
 * @param separator - The string used to join fragment texts (e.g. "" or "\n").
 * @returns Merged entity array, or `undefined` if there are none.
 */
export function mergeFragmentEntities(
  fragments: ReadonlyArray<{ text: string; entities?: MessageEntity[] }>,
  separator = "",
): MessageEntity[] | undefined {
  const merged: MessageEntity[] = [];
  let offset = 0;
  for (let i = 0; i < fragments.length; i++) {
    const { text, entities } = fragments[i];
    if (separator && i > 0 && text) {
      offset += separator.length;
    }
    if (entities) {
      for (const e of entities) {
        merged.push({ ...e, offset: e.offset + offset });
      }
    }
    offset += text.length;
  }
  return merged.length > 0 ? merged : undefined;
}
