import type { MessageEntity } from "@grammyjs/types";

/**
 * A string with associated Telegram message entities for rich formatting.
 * Inspired by gramio's FormattableString approach — entities-only, no parse_mode.
 */
export class FormattableString {
  readonly text: string;
  readonly entities: MessageEntity[];

  constructor(text: string, entities: MessageEntity[] = []) {
    this.text = text;
    this.entities = entities;
  }

  toString(): string {
    return this.text;
  }
}

type FormattableInput = string | FormattableString;

function toFormattable(input: FormattableInput): FormattableString {
  if (input instanceof FormattableString) {
    return input;
  }
  return new FormattableString(String(input));
}

/**
 * Shift all entity offsets by a given amount.
 */
function shiftEntities(entities: MessageEntity[], offset: number): MessageEntity[] {
  if (offset === 0) {
    return entities;
  }
  return entities.map((e) => ({ ...e, offset: e.offset + offset }));
}

/**
 * Factory for simple formatters (bold, italic, code, etc.) that wrap text
 * in a single entity with no extra arguments.
 */
function buildFormatter(type: MessageEntity["type"]) {
  return (input: FormattableInput): FormattableString => {
    const inner = toFormattable(input);
    const wrapper: MessageEntity = {
      type,
      offset: 0,
      length: inner.text.length,
    } as MessageEntity;
    return new FormattableString(inner.text, [wrapper, ...inner.entities]);
  };
}

/**
 * Factory for formatters that need additional arguments beyond the text.
 */
function buildFormatterWithArgs<K extends string>(type: MessageEntity["type"], ...keys: K[]) {
  return (input: FormattableInput, ...args: string[]): FormattableString => {
    const inner = toFormattable(input);
    const extra: Record<string, string> = {};
    for (let i = 0; i < keys.length; i++) {
      if (args[i] !== undefined) {
        extra[keys[i]] = args[i];
      }
    }
    const wrapper = {
      type,
      offset: 0,
      length: inner.text.length,
      ...extra,
    } as MessageEntity;
    return new FormattableString(inner.text, [wrapper, ...inner.entities]);
  };
}

// Simple formatters
export const bold = buildFormatter("bold");
export const italic = buildFormatter("italic");
export const underline = buildFormatter("underline");
export const strikethrough = buildFormatter("strikethrough");
export const spoiler = buildFormatter("spoiler");
export const code = buildFormatter("code");
export const blockquote = buildFormatter("blockquote");

// Formatters with extra arguments
export const pre = buildFormatterWithArgs("pre", "language");
export const link = buildFormatterWithArgs("text_link", "url");
export const customEmoji = buildFormatterWithArgs("custom_emoji", "custom_emoji_id");

/**
 * Template literal tag for composing FormattableString values.
 *
 * Usage:
 * ```ts
 * const msg = format`Hello ${bold("world")}! ${customEmoji("⚔️", "12345")}`;
 * ```
 */
export function format(
  strings: TemplateStringsArray,
  ...values: FormattableInput[]
): FormattableString {
  let text = "";
  const entities: MessageEntity[] = [];

  for (let i = 0; i < strings.length; i++) {
    text += strings[i];

    if (i < values.length) {
      const value = values[i];
      if (value == null) {
        continue;
      }
      const part = toFormattable(value);
      entities.push(...shiftEntities(part.entities, text.length));
      text += part.text;
    }
  }

  return new FormattableString(text, entities);
}

/**
 * Join an array of items into a FormattableString with a separator.
 *
 * Usage:
 * ```ts
 * const list = join(items, (item) => bold(item.name), "\n");
 * ```
 */
export function join<T>(
  array: T[],
  fn: (item: T, index: number) => FormattableInput,
  separator: FormattableInput = "",
): FormattableString {
  if (array.length === 0) {
    return new FormattableString("");
  }

  const sep = toFormattable(separator);
  let text = "";
  const entities: MessageEntity[] = [];

  for (let i = 0; i < array.length; i++) {
    if (i > 0 && sep.text) {
      entities.push(...shiftEntities(sep.entities, text.length));
      text += sep.text;
    }

    const part = toFormattable(fn(array[i], i));
    entities.push(...shiftEntities(part.entities, text.length));
    text += part.text;
  }

  return new FormattableString(text, entities);
}
