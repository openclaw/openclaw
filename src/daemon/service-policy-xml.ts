import { DOMParser } from "linkedom";

/**
 * Task Scheduler omits Settings.Enabled=true from its export and inserts Enabled=false in schema
 * order when a task is disabled. Return the definition without that one plain, direct field so it
 * can be compared with an earlier export, or null when that field is absent or not plain; no other
 * XML is canonicalized.
 */
export function omitNativeScheduledTaskEnabled(xml: string): string | null {
  const document = new DOMParser().parseFromString(xml, "text/xml");
  if (document.documentElement?.tagName !== "Task" || document.doctype) {
    return null;
  }
  const settings = [...document.documentElement.children].filter(
    (node) => node.tagName === "Settings",
  );
  const enabled =
    settings.length === 1
      ? [...settings[0]!.children].filter((node) => node.tagName === "Enabled")
      : [];
  if (
    enabled.length !== 1 ||
    enabled[0]!.children.length !== 0 ||
    enabled[0]!.getAttributeNames().length !== 0 ||
    !/^(true|false)$/u.test(enabled[0]!.textContent.trim())
  ) {
    return null;
  }
  const omitted = xml.replace(
    /(<Settings(?:\s[^>]*)?>)([\s\S]*?)(<\/Settings>)/u,
    (match, open: string, body: string, close: string) => {
      const fields = [...body.matchAll(/[\t \r\n]*<Enabled>\s*(true|false)\s*<\/Enabled>/gu)];
      return fields.length === 1 ? `${open}${body.replace(fields[0]![0], "")}${close}` : match;
    },
  );
  return omitted === xml ? null : omitted;
}

/** Preserve audited native policy nodes without decoding plist data/date values as JSON. */
export function preserveServicePolicyXml(
  generated: string,
  previous: string,
  keys: readonly string[],
  format: "plist" | "Task",
): string {
  const parser = new DOMParser();
  const candidate = parser.parseFromString(generated, "text/xml");
  const installed = parser.parseFromString(previous, "text/xml");
  const field = (document: typeof candidate, key: string) =>
    format === "plist"
      ? [...document.querySelectorAll("plist > dict > key")].find(
          (node) => node.textContent === key,
        )?.nextElementSibling
      : document.querySelector(key.replaceAll(".", " > "));
  for (const key of keys) {
    const original = field(installed, key);
    const replacement = field(candidate, key);
    if (!original || !replacement) {
      throw new Error(`Custom service policy ${key} disappeared before publication.`);
    }
    replacement.replaceWith(original.cloneNode(true));
  }
  return `${generated.slice(0, generated.indexOf(`<${format}`))}${candidate.documentElement.outerHTML}\n`;
}
