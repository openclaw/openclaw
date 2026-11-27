type TranslationMap = { readonly [key: string]: string | TranslationMap };

function lookup(messages: TranslationMap | undefined, key: string): unknown {
  let value: string | TranslationMap | undefined = messages;
  for (const part of key.split(".")) {
    value = value && typeof value === "object" ? value[part] : undefined;
  }
  return value;
}

/** Translate plugin-owned messages without owning their loading, state, or locale. */
export function translateControlUiMessage(
  messages: (locale: string) => TranslationMap | undefined,
  locale: string,
  key: string,
  params?: Record<string, string>,
): string {
  const value = lookup(messages(locale), key) ?? lookup(messages("en"), key);
  return typeof value === "string"
    ? value.replace(/\{(\w+)\}/g, (_, name: string) => params?.[name] ?? `{${name}}`)
    : key;
}
