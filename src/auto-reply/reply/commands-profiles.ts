import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { updateSessionStore } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

type ParsedProfileCommand =
  | { kind: "set"; profileId: string; provider?: string }
  | { kind: "clear"; provider?: string }
  | { kind: "status" };

type ParsedProfilesCommand = { provider?: string };

function parseProviderFlag(tokens: string[]): { provider?: string; error?: string } {
  const idx = tokens.findIndex((token) => token === "--provider");
  if (idx < 0) {
    return {};
  }
  const value = tokens[idx + 1]?.trim();
  if (!value) {
    return { error: "Missing value for --provider." };
  }
  if (idx + 2 < tokens.length) {
    return { error: "Unexpected extra arguments after --provider <provider>." };
  }
  return { provider: value };
}

function parseProfileCommand(raw: string): ParsedProfileCommand | { error: string } {
  const argText = raw.replace(/^\/profile\b/i, "").trim();
  if (!argText) {
    return { kind: "status" };
  }
  const tokens = argText.split(/\s+/).filter(Boolean);
  const first = tokens[0]?.toLowerCase();
  if (first === "clear") {
    const parsed = parseProviderFlag(tokens.slice(1));
    if (parsed.error) {
      return { error: parsed.error };
    }
    return { kind: "clear", provider: parsed.provider };
  }

  const profileId = tokens[0]?.trim();
  if (!profileId) {
    return { error: "Usage: /profile <id> [--provider <provider>]" };
  }
  const parsed = parseProviderFlag(tokens.slice(1));
  if (parsed.error) {
    return { error: parsed.error };
  }
  return { kind: "set", profileId, provider: parsed.provider };
}

function parseProfilesCommand(raw: string): ParsedProfilesCommand | { error: string } {
  const argText = raw.replace(/^\/profiles\b/i, "").trim();
  if (!argText) {
    return {};
  }
  const tokens = argText.split(/\s+/).filter(Boolean);
  const parsed = parseProviderFlag(tokens);
  if (parsed.error) {
    return { error: parsed.error };
  }
  return { provider: parsed.provider };
}

async function persistSessionEntry(params: Parameters<CommandHandler>[0]): Promise<boolean> {
  if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) {
    return false;
  }
  params.sessionEntry.updatedAt = Date.now();
  params.sessionStore[params.sessionKey] = params.sessionEntry;
  if (params.storePath) {
    await updateSessionStore(params.storePath, (store) => {
      store[params.sessionKey] = params.sessionEntry!;
    });
  }
  return true;
}

function resolveTargetProvider(inputProvider: string | undefined, runtimeProvider: string): string {
  return normalizeProviderId((inputProvider ?? runtimeProvider).trim());
}

function formatProviderProfiles(params: {
  provider: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
  cfg: Parameters<typeof resolveAuthProfileOrder>[0]["cfg"];
}) {
  const order = resolveAuthProfileOrder({
    cfg: params.cfg,
    store: params.store,
    provider: params.provider,
  });
  const seen = new Set(order);
  const fallback = Object.entries(params.store.profiles)
    .filter(([, entry]) => normalizeProviderId(entry.provider) === params.provider)
    .map(([profileId]) => profileId)
    .filter((id) => !seen.has(id));
  return [...order, ...fallback];
}

export const handleProfilesCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/profiles" && !normalized.startsWith("/profiles ")) {
    return null;
  }

  const parsed = parseProfilesCommand(normalized);
  if ("error" in parsed) {
    return { shouldContinue: false, reply: { text: `⚠️ ${parsed.error}` } };
  }

  const provider = resolveTargetProvider(parsed.provider, params.provider);
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const ids = formatProviderProfiles({ provider, store, cfg: params.cfg });
  const active = params.sessionEntry?.authProfileOverride?.trim();
  const activeProvider = active ? store.profiles[active]?.provider : undefined;
  const hasActive = Boolean(active && normalizeProviderId(activeProvider ?? "") === provider);

  if (ids.length === 0) {
    return {
      shouldContinue: false,
      reply: {
        text: [
          `👤 Profiles (${provider}): none`,
          `Login: openclaw models auth login --provider ${provider} --profile-id <id>`,
          `Set: /profile <id>${provider !== normalizeProviderId(params.provider) ? ` --provider ${provider}` : ""}`,
        ].join("\n"),
      },
    };
  }

  const lines = ids.map((id) => {
    const marker = hasActive && id === active ? "*" : "-";
    return `${marker} ${id}`;
  });

  return {
    shouldContinue: false,
    reply: {
      text: [
        `👤 Profiles (${provider})`,
        ...lines,
        hasActive ? `Active: ${active}` : "Active: inherited/default",
        `Set: /profile <id>${provider !== normalizeProviderId(params.provider) ? ` --provider ${provider}` : ""}`,
      ].join("\n"),
    },
  };
};

export const handleProfileCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/profile" && !normalized.startsWith("/profile ")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /profile from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const parsed = parseProfileCommand(normalized);
  if ("error" in parsed) {
    return { shouldContinue: false, reply: { text: `⚠️ ${parsed.error}` } };
  }

  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  if (parsed.kind === "status") {
    const current = params.sessionEntry?.authProfileOverride?.trim();
    return {
      shouldContinue: false,
      reply: {
        text: current
          ? `👤 Session profile override: ${current}`
          : "👤 Session profile override: none (using defaults)",
      },
    };
  }

  if (parsed.kind === "clear") {
    if (params.sessionEntry) {
      delete params.sessionEntry.authProfileOverride;
      delete params.sessionEntry.authProfileOverrideSource;
      delete params.sessionEntry.authProfileOverrideCompactionCount;
      await persistSessionEntry(params);
    }
    return {
      shouldContinue: false,
      reply: { text: "👤 Cleared session profile override; using defaults." },
    };
  }

  const provider = resolveTargetProvider(parsed.provider, params.provider);
  const entry = store.profiles[parsed.profileId];
  if (!entry) {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ Auth profile "${parsed.profileId}" not found.` },
    };
  }
  if (normalizeProviderId(entry.provider) !== provider) {
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ Auth profile "${parsed.profileId}" is for ${entry.provider}, not ${provider}.`,
      },
    };
  }

  if (params.sessionEntry) {
    params.sessionEntry.authProfileOverride = parsed.profileId;
    params.sessionEntry.authProfileOverrideSource = "user";
    delete params.sessionEntry.authProfileOverrideCompactionCount;
    await persistSessionEntry(params);
  }

  return {
    shouldContinue: false,
    reply: {
      text: `👤 Session profile override set to ${parsed.profileId} (${provider}).`,
    },
  };
};
