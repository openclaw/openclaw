import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";

/** Assign readable names in recording order. Keep account IDs local to this transcript. */
export function createTranscriptSpeakerLabels() {
  const labels = new Map<string, string>();
  const suffixes = new Map<string, number>();

  return (id: string | null | undefined, rawLabel: string | null | undefined): string => {
    const label = sanitizeTerminalText(rawLabel ?? "").trim();
    // A label-only importer cannot attest that its "Sam" is an identified account.
    const key = id ? `id:${id}` : `label:${label}`;
    const known = labels.get(key);
    if (known !== undefined || !label) {
      return known ?? "";
    }

    let display = label;
    let suffix = suffixes.get(label) ?? 1;
    // A literal display name such as "Sam (2)" can already own a numbered name.
    while (suffixes.has(display)) {
      suffix += 1;
      display = `${label} (${suffix})`;
    }
    suffixes.set(label, suffix);
    suffixes.set(display, 1);
    labels.set(key, display);
    return display;
  };
}
