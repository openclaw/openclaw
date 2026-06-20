// User-editable session labels are short display strings saved in session
// metadata; parser returns structured errors for CLI/API callers.
export const SESSION_LABEL_MAX_LENGTH = 512;
export const SESSION_TITLE_MAX_LENGTH = SESSION_LABEL_MAX_LENGTH;

type ParsedSessionLabel = { ok: true; label: string } | { ok: false; error: string };
type ParsedSessionTitle = { ok: true; title: string } | { ok: false; error: string };

type SessionTitleEntry = {
  title?: string;
  label?: string;
};

function normalizeSessionTitleText(raw: string): string {
  return raw.trim().normalize("NFC");
}

export function parseSessionTitle(raw: unknown): ParsedSessionTitle {
  if (typeof raw !== "string") {
    return { ok: false, error: "invalid title: must be a string" };
  }
  const title = normalizeSessionTitleText(raw);
  if (!title) {
    return { ok: false, error: "invalid title: empty" };
  }
  if (title.length > SESSION_TITLE_MAX_LENGTH) {
    return {
      ok: false,
      error: `invalid title: too long (max ${SESSION_TITLE_MAX_LENGTH})`,
    };
  }
  return { ok: true, title };
}

export function parseSessionLabel(raw: unknown): ParsedSessionLabel {
  const parsed = parseSessionTitle(raw);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error.replace("title", "label") };
  }
  return { ok: true, label: parsed.title };
}

export function getSessionTitleFromEntry(
  entry: SessionTitleEntry | null | undefined,
): string | undefined {
  const title = typeof entry?.title === "string" ? normalizeSessionTitleText(entry.title) : "";
  if (title) {
    return title;
  }
  const label = typeof entry?.label === "string" ? normalizeSessionTitleText(entry.label) : "";
  return label || undefined;
}

export function applySessionTitle(entry: SessionTitleEntry, title: string | null): void {
  if (title === null) {
    delete entry.title;
    delete entry.label;
    return;
  }
  const normalized = normalizeSessionTitleText(title);
  entry.title = normalized;
  // Keep the legacy label mirror populated so older clients, selectors, and UI
  // paths keep working while title is the canonical user-set name.
  entry.label = normalized;
}

export function sessionTitlesEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  return normalizeSessionTitleText(left) === normalizeSessionTitleText(right);
}
