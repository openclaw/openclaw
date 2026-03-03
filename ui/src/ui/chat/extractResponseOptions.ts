const TRIGGERS = [
  "reply with:",
  "respond with:",
  "answer with:",
  "choose one:",
];

export function extractResponseOptions(message: string): string[] {
  if (!message) return [];

  const lower = message.toLowerCase();

  const trigger = TRIGGERS.find((t) => lower.includes(t));
  if (!trigger) return [];

  const start = lower.indexOf(trigger);
  const after = message.slice(start + trigger.length).trim();
  if (!after) return [];

  const rawTokens = after.split(/[\/|,]/);

  const tokens = rawTokens
    .map((t) => t.trim())
    .filter((t) => /^[a-zA-Z0-9_-]{1,32}$/.test(t));

  return tokens.slice(0, 5);
}
