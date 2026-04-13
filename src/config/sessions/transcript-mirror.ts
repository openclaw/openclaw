import path from "node:path";

function stripQuery(value: string): string {
  const noHash = value.split("#")[0] ?? value;
  return noHash.split("?")[0] ?? noHash;
}

function extractFileNameFromMediaUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = stripQuery(trimmed);
  try {
    const parsed = new URL(cleaned);
    const base = path.basename(parsed.pathname);
    if (!base) {
      return null;
    }
    try {
      return decodeURIComponent(base);
    } catch {
      return base;
    }
  } catch {
    const base = path.basename(cleaned);
    if (!base || base === "/" || base === ".") {
      return null;
    }
    return base;
  }
}

const OPERATIONAL_ALERT_PATTERNS = [
  /^⚠️\s*error en\b/i,
  /^alerta de backup:/i,
  /^git backup failed\b/i,
  /^se han producido conflictos durante el pull --rebase\b/i,
];

export function isOperationalAlertMirrorText(text: string): boolean {
  const trimmed = text.trim();
  return OPERATIONAL_ALERT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function resolveMirroredTranscriptText(params: {
  text?: string;
  mediaUrls?: string[];
}): string | null {
  const mediaUrls = params.mediaUrls?.filter((url) => url && url.trim()) ?? [];
  if (mediaUrls.length > 0) {
    const names = mediaUrls
      .map((url) => extractFileNameFromMediaUrl(url))
      .filter((name): name is string => Boolean(name && name.trim()));
    if (names.length > 0) {
      return names.join(", ");
    }
    return "media";
  }

  const text = params.text ?? "";
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (isOperationalAlertMirrorText(trimmed)) {
    return null;
  }
  return trimmed;
}
