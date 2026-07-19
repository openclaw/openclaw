import { formatSenderLabel, type SenderIdentity } from "./chat/sender-label.ts";

export type IdentityAvatarInput = SenderIdentity & {
  profileAvatarUrl?: string;
  /**
   * Base URL of a gateway-side avatar proxy (same-origin). When absent, the
   * email-hash avatar tier is disabled entirely: the browser must never
   * contact a third-party avatar host directly, because that leaks a
   * dictionary-recoverable sender email hash plus the viewer's IP per render.
   */
  avatarProxyBaseUrl?: string;
};

export type ResolvedIdentityAvatar =
  | { kind: "profile"; url: string }
  | { kind: "gravatar"; url: string }
  | { kind: "initials"; initials: string; colorSeed: number };

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/;

function initialsFromLabel(label: string): string {
  const words = label.trim().split(/\s+/u).filter(Boolean).slice(0, 2);
  const initials = words.map((word) => Array.from(word)[0] ?? "").join("");
  return initials.toUpperCase() || "?";
}

function stableColorSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

async function sha256Hex(value: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle) {
    return null;
  }
  try {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  } catch {
    return null;
  }
}

/** Resolves profile, Gravatar, then deterministic initials without fetching profile data. */
export async function resolveAvatar(input: IdentityAvatarInput): Promise<ResolvedIdentityAvatar> {
  const profileAvatarUrl = input.profileAvatarUrl?.trim();
  if (profileAvatarUrl) {
    return { kind: "profile", url: profileAvatarUrl };
  }

  const id = input.id?.trim();
  const proxyBase = input.avatarProxyBaseUrl?.trim().replace(/\/+$/, "");
  if (proxyBase && id && EMAIL_PATTERN.test(id)) {
    const hash = await sha256Hex(id.toLowerCase());
    if (hash) {
      return {
        kind: "gravatar",
        url: `${proxyBase}/${hash}?s=64`,
      };
    }
  }

  const label = formatSenderLabel(input) ?? "?";
  return {
    kind: "initials",
    initials: initialsFromLabel(label),
    colorSeed: stableColorSeed(id || label),
  };
}
