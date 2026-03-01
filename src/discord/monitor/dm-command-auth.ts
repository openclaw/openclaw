import { resolveCommandAuthorizedFromAuthorizers } from "../../channels/command-gating.js";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  type DmGroupAccessDecision,
} from "../../security/dm-policy-shared.js";
import { normalizeDiscordAllowList, resolveDiscordAllowListMatch } from "./allow-list.js";

const DISCORD_ALLOW_LIST_PREFIXES = ["discord:", "user:", "pk:"];

export type DiscordDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

export type DiscordDmCommandAccess = {
  decision: DmGroupAccessDecision;
  reason: string;
  commandAuthorized: boolean;
  allowMatch: ReturnType<typeof resolveDiscordAllowListMatch> | { allowed: false };
};

export async function resolveDiscordDmCommandAccess(params: {
  accountId: string;
  dmPolicy: DiscordDmPolicy;
  configuredAllowFrom: string[];
  sender: { id: string; name?: string; tag?: string };
  allowNameMatching: boolean;
  useAccessGroups: boolean;
  readStoreAllowFrom?: () => Promise<string[]>;
}): Promise<DiscordDmCommandAccess> {
  const storeAllowFrom = params.readStoreAllowFrom
    ? await params.readStoreAllowFrom().catch(() => [])
    : await readStoreAllowFromForDmPolicy({
        provider: "discord",
        accountId: params.accountId,
        dmPolicy: params.dmPolicy,
      });

  const access = resolveDmGroupAccessWithLists({
    isGroup: false,
    dmPolicy: params.dmPolicy,
    allowFrom: params.configuredAllowFrom,
    groupAllowFrom: [],
    storeAllowFrom,
    isSenderAllowed: (allowEntries) => {
      const allowList = normalizeDiscordAllowList(allowEntries, DISCORD_ALLOW_LIST_PREFIXES);
      const allowMatch = allowList
        ? resolveDiscordAllowListMatch({
            allowList,
            candidate: params.sender,
            allowNameMatching: params.allowNameMatching,
          })
        : { allowed: false };
      return allowMatch.allowed;
    },
  });

  const commandAllowList = normalizeDiscordAllowList(
    access.effectiveAllowFrom,
    DISCORD_ALLOW_LIST_PREFIXES,
  );
  const allowMatch = commandAllowList
    ? resolveDiscordAllowListMatch({
        allowList: commandAllowList,
        candidate: params.sender,
        allowNameMatching: params.allowNameMatching,
      })
    : { allowed: false };

  const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups: params.useAccessGroups,
    authorizers: [
      {
        configured: access.effectiveAllowFrom.length > 0,
        allowed: allowMatch.allowed,
      },
    ],
    modeWhenAccessGroupsOff: "configured",
  });
  const effectiveCommandAuthorized =
    access.decision === "allow" && params.dmPolicy === "open" ? true : commandAuthorized;

  return {
    decision: access.decision,
    reason: access.reason,
    commandAuthorized: effectiveCommandAuthorized,
    allowMatch,
  };
}
