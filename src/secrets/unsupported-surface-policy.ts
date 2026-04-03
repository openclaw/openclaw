import { isRecord } from "../utils.js";

export const UNSUPPORTED_SECRETREF_SURFACE_PATTERNS = [
  "commands.ownerDisplaySecret",
  "hooks.token",
  "hooks.gmail.pushToken",
  "hooks.mappings[].sessionKey",
  "auth-profiles.oauth.*",
  "channels.discord.threadBindings.webhookToken",
  "channels.discord.accounts.*.threadBindings.webhookToken",
  "channels.whatsapp.creds.json",
  "channels.whatsapp.accounts.*.creds.json",
] as const;

export type UnsupportedSecretRefConfigCandidate = {
  path: string;
  value: unknown;
};

export function collectUnsupportedSecretRefConfigCandidates(
  raw: unknown,
): UnsupportedSecretRefConfigCandidate[] {
  if (!isRecord(raw)) {
    return [];
  }

  const candidates: UnsupportedSecretRefConfigCandidate[] = [];

  const commands = isRecord(raw.commands) ? raw.commands : null;
  if (commands) {
    candidates.push({
      path: "commands.ownerDisplaySecret",
      value: commands.ownerDisplaySecret,
    });
  }

  const hooks = isRecord(raw.hooks) ? raw.hooks : null;
  if (hooks) {
    candidates.push({ path: "hooks.token", value: hooks.token });

    const gmail = isRecord(hooks.gmail) ? hooks.gmail : null;
    if (gmail) {
      candidates.push({
        path: "hooks.gmail.pushToken",
        value: gmail.pushToken,
      });
    }

    const mappings = hooks.mappings;
    if (Array.isArray(mappings)) {
      for (const [index, mapping] of mappings.entries()) {
        if (!isRecord(mapping)) {
          continue;
        }
        candidates.push({
          path: `hooks.mappings.${index}.sessionKey`,
          value: mapping.sessionKey,
        });
      }
    }
  }

  const channels = isRecord(raw.channels) ? raw.channels : null;
  if (!channels) {
    return candidates;
  }

  const discord = isRecord(channels.discord) ? channels.discord : null;
  if (discord) {
    const threadBindings = isRecord(discord.threadBindings) ? discord.threadBindings : null;
    if (threadBindings) {
      candidates.push({
        path: "channels.discord.threadBindings.webhookToken",
        value: threadBindings.webhookToken,
      });
    }
    const accounts = isRecord(discord.accounts) ? discord.accounts : null;
    if (accounts) {
      for (const [accountId, account] of Object.entries(accounts)) {
        if (!isRecord(account)) {
          continue;
        }
        const accountThreadBindings = isRecord(account.threadBindings)
          ? account.threadBindings
          : null;
        if (!accountThreadBindings) {
          continue;
        }
        candidates.push({
          path: `channels.discord.accounts.${accountId}.threadBindings.webhookToken`,
          value: accountThreadBindings.webhookToken,
        });
      }
    }
  }

  const whatsapp = isRecord(channels.whatsapp) ? channels.whatsapp : null;
  if (!whatsapp) {
    return candidates;
  }

  const creds = isRecord(whatsapp.creds) ? whatsapp.creds : null;
  if (creds) {
    candidates.push({
      path: "channels.whatsapp.creds.json",
      value: creds.json,
    });
  }
  const accounts = isRecord(whatsapp.accounts) ? whatsapp.accounts : null;
  if (!accounts) {
    return candidates;
  }
  for (const [accountId, account] of Object.entries(accounts)) {
    if (!isRecord(account)) {
      continue;
    }
    const accountCreds = isRecord(account.creds) ? account.creds : null;
    if (!accountCreds) {
      continue;
    }
    candidates.push({
      path: `channels.whatsapp.accounts.${accountId}.creds.json`,
      value: accountCreds.json,
    });
  }

  return candidates;
}
