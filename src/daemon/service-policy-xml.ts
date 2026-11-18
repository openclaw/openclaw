import { DOMParser } from "linkedom";

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
