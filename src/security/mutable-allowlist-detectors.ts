export function isDiscordMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }

  const maybeMentionId = text.replace(/^<@!?/, "").replace(/>$/, "");
  if (/^\d+$/.test(maybeMentionId)) {
    return false;
  }

  for (const prefix of ["discord:", "user:", "pk:"]) {
    if (!text.startsWith(prefix)) {
      continue;
    }
    return text.slice(prefix.length).trim().length === 0;
  }

  return true;
}

export function isSlackMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }

  const mentionMatch = text.match(/^<@([A-Z0-9]+)>$/i);
  if (mentionMatch && /^[A-Z0-9]{8,}$/i.test(mentionMatch[1] ?? "")) {
    return false;
  }

  const withoutPrefix = text.replace(/^(slack|user):/i, "").trim();
  if (/^[UWBCGDT][A-Z0-9]{2,}$/.test(withoutPrefix)) {
    return false;
  }
  if (/^[A-Z0-9]{8,}$/i.test(withoutPrefix)) {
    return false;
  }

  return true;
}

export function isGoogleChatMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }

  const withoutPrefix = text.replace(/^(googlechat|google-chat|gchat):/i, "").trim();
  if (!withoutPrefix) {
    return false;
  }

  const withoutUsers = withoutPrefix.replace(/^users\//i, "");
  return withoutUsers.includes("@");
}

export function isMSTeamsMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }

  const withoutPrefix = text.replace(/^(msteams|user):/i, "").trim();
  return /\s/.test(withoutPrefix) || withoutPrefix.includes("@");
}

export function isMattermostMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }

  const normalized = text
    .replace(/^(mattermost|user):/i, "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();

  // Mattermost user IDs are stable 26-char lowercase/number tokens.
  if (/^[a-z0-9]{26}$/.test(normalized)) {
    return false;
  }

  return true;
}

export function isIrcMutableAllowEntry(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  if (!text || text === "*") {
    return false;
  }

  const normalized = text
    .replace(/^irc:/, "")
    .replace(/^user:/, "")
    .trim();

  return !normalized.includes("!") && !normalized.includes("@");
}
