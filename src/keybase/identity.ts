export type KeybaseSender = {
  kind: "username";
  username: string;
};

type KeybaseAllowEntry = { kind: "any" } | { kind: "username"; username: string };

function stripKeybasePrefix(value: string): string {
  return value.replace(/^keybase:/i, "").trim();
}

export function resolveKeybaseSender(params: { username?: string | null }): KeybaseSender | null {
  const username = params.username?.trim();
  if (!username) {
    return null;
  }
  return { kind: "username", username: username.toLowerCase() };
}

export function formatKeybaseSenderId(sender: KeybaseSender): string {
  return sender.username;
}

export function formatKeybaseSenderDisplay(sender: KeybaseSender): string {
  return sender.username;
}

export function formatKeybasePairingIdLine(sender: KeybaseSender): string {
  return `Your Keybase username: ${sender.username}`;
}

export function resolveKeybaseRecipient(sender: KeybaseSender): string {
  return sender.username;
}

export function resolveKeybasePeerId(sender: KeybaseSender): string {
  return sender.username;
}

function parseKeybaseAllowEntry(entry: string): KeybaseAllowEntry | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return { kind: "any" };
  }
  const stripped = stripKeybasePrefix(trimmed).toLowerCase();
  if (!stripped) {
    return null;
  }
  return { kind: "username", username: stripped };
}

export function isKeybaseSenderAllowed(sender: KeybaseSender, allowFrom: string[]): boolean {
  if (allowFrom.length === 0) {
    return false;
  }
  const parsed = allowFrom
    .map(parseKeybaseAllowEntry)
    .filter((entry): entry is KeybaseAllowEntry => entry !== null);
  if (parsed.some((entry) => entry.kind === "any")) {
    return true;
  }
  return parsed.some((entry) => {
    if (entry.kind === "username") {
      return entry.username === sender.username;
    }
    return false;
  });
}

export function isKeybaseGroupAllowed(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  allowFrom: string[];
  sender: KeybaseSender;
}): boolean {
  const { groupPolicy, allowFrom, sender } = params;
  if (groupPolicy === "disabled") {
    return false;
  }
  if (groupPolicy === "open") {
    return true;
  }
  if (allowFrom.length === 0) {
    return false;
  }
  return isKeybaseSenderAllowed(sender, allowFrom);
}
