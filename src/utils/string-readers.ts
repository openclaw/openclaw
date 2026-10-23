import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

type StringOptions<T extends string> = readonly T[] | ReadonlySet<T>;

export function isStringOption<T extends string>(
  value: unknown,
  options: StringOptions<T>,
): value is T {
  return (
    typeof value === "string" &&
    (Array.isArray(options)
      ? (options as readonly string[]).includes(value)
      : (options as ReadonlySet<string>).has(value))
  );
}

export function readTrimmedStringAlias(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  return readParsedField(record, keys, normalizeOptionalString);
}

/** Reads the first parsed field, preserving order and defined falsy values. */
export function readParsedField<T>(
  record: Readonly<Record<string, unknown>>,
  keys: string | readonly string[],
  parse: (value: unknown) => T | undefined,
): T | undefined {
  for (const key of typeof keys === "string" ? [keys] : keys) {
    const value = parse(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function stripChannelPrefix(
  value: string | undefined,
  channelId: string,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const genericPrefixes = ["channel:", "chat:", "user:"];
  for (const prefix of genericPrefixes) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  const prefix = `${channelId}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
