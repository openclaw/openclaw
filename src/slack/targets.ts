export type SlackTargetKind = "user" | "channel";

export type SlackTarget = {
  kind: SlackTargetKind;
  id: string;
  raw: string;
  normalized: string;
};

type SlackTargetParseOptions = {
  defaultKind?: SlackTargetKind;
};

function normalizeTargetId(kind: SlackTargetKind, id: string) {
  return `${kind}:${id}`.toLowerCase();
}

function buildTarget(kind: SlackTargetKind, id: string, raw: string): SlackTarget {
  return {
    kind,
    id,
    raw,
    normalized: normalizeTargetId(kind, id),
  };
}

export function parseSlackTarget(
  raw: string,
  options: SlackTargetParseOptions = {},
): SlackTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const mentionMatch = trimmed.match(/^<@([A-Z0-9]+)>$/i);
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
  if (trimmed.startsWith("slack:")) {
    const id = trimmed.slice("slack:".length).trim();
    return id ? buildTarget("user", id, trimmed) : undefined;
  }
  if (trimmed.startsWith("@")) {
    const candidate = trimmed.slice(1).trim();
    if (!/^[A-Z0-9]+$/i.test(candidate)) {
      throw new Error("Slack DMs require a user id (use user:<id> or <@id>)");
    }
    return buildTarget("user", candidate, trimmed);
  }
  if (trimmed.startsWith("#")) {
    const candidate = trimmed.slice(1).trim();
    if (!/^[A-Z0-9]+$/i.test(candidate)) {
      throw new Error("Slack channels require a channel id (use channel:<id>)");
    }
    return buildTarget("channel", candidate, trimmed);
  }
  if (options.defaultKind) {
    return buildTarget(options.defaultKind, trimmed, trimmed);
  }
  return buildTarget("channel", trimmed, trimmed);
}

export function resolveSlackChannelId(raw: string): string {
  const target = parseSlackTarget(raw, { defaultKind: "channel" });
  if (!target) {
    throw new Error("Slack channel id is required.");
  }
  if (target.kind !== "channel") {
    throw new Error("Slack channel id is required (use channel:<id>).");
  }
  return target.id;
}
