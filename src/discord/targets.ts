export type DiscordTargetKind = "user" | "channel";

export type DiscordTarget = {
  kind: DiscordTargetKind;
  id: string;
  raw: string;
  normalized: string;
};

type DiscordTargetParseOptions = {
  defaultKind?: DiscordTargetKind;
  ambiguousMessage?: string;
};

function normalizeTargetId(kind: DiscordTargetKind, id: string) {
  return `${kind}:${id}`.toLowerCase();
}

function buildTarget(kind: DiscordTargetKind, id: string, raw: string): DiscordTarget {
  return {
    kind,
    id,
    raw,
    normalized: normalizeTargetId(kind, id),
  };
}

export function parseDiscordTarget(
  raw: string,
  options: DiscordTargetParseOptions = {},
): DiscordTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const mentionMatch = trimmed.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    return buildTarget("user", mentionMatch[1], trimmed);
  }
  if (trimmed.startsWith("user:")) {
    const id = trimmed.slice("user:".length).trim();
    return id ? buildTarget("user", id, trimmed) : undefined;
  }
  if (trimmed.startsWith("channel:")) {
    const id = trimmed.slice("channel:".length).trim();
    return id ? buildTarget("channel", id, trimmed) : undefined;
  }
  if (trimmed.startsWith("discord:")) {
    const id = trimmed.slice("discord:".length).trim();
    return id ? buildTarget("user", id, trimmed) : undefined;
  }
  if (trimmed.startsWith("@")) {
    const candidate = trimmed.slice(1).trim();
    if (!/^\d+$/.test(candidate)) {
      throw new Error("Discord DMs require a user id (use user:<id> or a <@id> mention)");
    }
    return buildTarget("user", candidate, trimmed);
  }
  if (/^\d+$/.test(trimmed)) {
    if (options.defaultKind) {
      return buildTarget(options.defaultKind, trimmed, trimmed);
    }
    throw new Error(
      options.ambiguousMessage ??
        `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`,
    );
  }
  return buildTarget("channel", trimmed, trimmed);
}

export function resolveDiscordChannelId(raw: string): string {
  const target = parseDiscordTarget(raw, { defaultKind: "channel" });
  if (!target) {
    throw new Error("Discord channel id is required.");
  }
  if (target.kind !== "channel") {
    throw new Error("Discord channel id is required (use channel:<id>).");
  }
  return target.id;
}
