import { normalizeWhatsAppTarget } from "../../whatsapp/normalize.js";

export function normalizeSlackMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const mentionMatch = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mentionMatch) return `user:${mentionMatch[1]}`.toLowerCase();
  if (trimmed.startsWith("user:")) {
    const id = trimmed.slice(5).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("channel:")) {
    const id = trimmed.slice(8).trim();
    return id ? `channel:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("group:")) {
    const id = trimmed.slice(6).trim();
    return id ? `channel:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("slack:")) {
    const id = trimmed.slice(6).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("@")) {
    const id = trimmed.slice(1).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("#")) {
    const id = trimmed.slice(1).trim();
    return id ? `channel:${id}`.toLowerCase() : undefined;
  }
  return `channel:${trimmed}`.toLowerCase();
}

export function looksLikeSlackTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^<@([A-Z0-9]+)>$/i.test(trimmed)) return true;
  if (/^(user|channel|group):/i.test(trimmed)) return true;
  if (/^slack:/i.test(trimmed)) return true;
  if (/^[@#]/.test(trimmed)) return true;
  return /^[CUWGD][A-Z0-9]{8,}$/i.test(trimmed);
}

export function normalizeDiscordMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const mentionMatch = trimmed.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return `user:${mentionMatch[1]}`.toLowerCase();
  if (trimmed.startsWith("user:")) {
    const id = trimmed.slice(5).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("channel:")) {
    const id = trimmed.slice(8).trim();
    return id ? `channel:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("group:")) {
    const id = trimmed.slice(6).trim();
    return id ? `channel:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("discord:")) {
    const id = trimmed.slice(8).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("@")) {
    const id = trimmed.slice(1).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  return `channel:${trimmed}`.toLowerCase();
}

export function looksLikeDiscordTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^<@!?\d+>$/.test(trimmed)) return true;
  if (/^(user|channel|group|discord):/i.test(trimmed)) return true;
  if (/^\d{6,}$/.test(trimmed)) return true;
  return false;
}

export function normalizeTelegramMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let normalized = trimmed;
  if (normalized.startsWith("telegram:")) {
    normalized = normalized.slice("telegram:".length).trim();
  } else if (normalized.startsWith("tg:")) {
    normalized = normalized.slice("tg:".length).trim();
  } else if (normalized.startsWith("group:")) {
    normalized = normalized.slice("group:".length).trim();
  }
  if (!normalized) return undefined;
  const tmeMatch =
    /^https?:\/\/t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized) ??
    /^t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized);
  if (tmeMatch?.[1]) normalized = `@${tmeMatch[1]}`;
  if (!normalized) return undefined;
  return `telegram:${normalized}`.toLowerCase();
}

export function looksLikeTelegramTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^(telegram|tg|group):/i.test(trimmed)) return true;
  if (trimmed.startsWith("@")) return true;
  return /^-?\d{6,}$/.test(trimmed);
}

export function normalizeSignalMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let normalized = trimmed;
  if (normalized.toLowerCase().startsWith("signal:")) {
    normalized = normalized.slice("signal:".length).trim();
  }
  if (!normalized) return undefined;
  const lower = normalized.toLowerCase();
  if (lower.startsWith("group:")) {
    const id = normalized.slice("group:".length).trim();
    return id ? `group:${id}`.toLowerCase() : undefined;
  }
  if (lower.startsWith("username:")) {
    const id = normalized.slice("username:".length).trim();
    return id ? `username:${id}`.toLowerCase() : undefined;
  }
  if (lower.startsWith("u:")) {
    const id = normalized.slice("u:".length).trim();
    return id ? `username:${id}`.toLowerCase() : undefined;
  }
  return normalized.toLowerCase();
}

export function looksLikeSignalTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^(signal:)?(group:|username:|u:)/i.test(trimmed)) return true;
  return /^\+?\d{3,}$/.test(trimmed);
}

export function normalizeWhatsAppMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return normalizeWhatsAppTarget(trimmed) ?? undefined;
}

export function looksLikeWhatsAppTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^whatsapp:/i.test(trimmed)) return true;
  if (trimmed.includes("@")) return true;
  return /^\+?\d{3,}$/.test(trimmed);
}
