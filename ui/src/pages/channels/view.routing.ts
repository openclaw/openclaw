import { normalizeAgentIdStrict } from "@openclaw/normalization-core/agent-id";
// Control UI view renders per-account agent routing for channel detail pages.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { resolveChannelAccounts } from "../../lib/channels/index.ts";
import { resolveConfigDraftBase } from "../../lib/config/config-draft-model.ts";
import type { ChannelsProps } from "./view.types.ts";

// Mirrors the runtime wildcard for "every account on the channel".
const WILDCARD_ACCOUNT = "*";
// Canonical implicit account id: must equal DEFAULT_ACCOUNT_ID in
// src/routing/account-id.ts (the runtime resolves channels without an
// accounts map, and bindings with an omitted accountId, to this id).
const DEFAULT_ACCOUNT_ID = "default";

type RouteBinding = {
  type?: string;
  agentId?: string;
  comment?: string;
  match?: {
    channel?: string;
    accountId?: string;
    peer?: unknown;
    guildId?: string;
    teamId?: string;
    roles?: string[];
  };
  session?: unknown;
  acp?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Canonical row identity. The runtime routing index trims and canonicalizes
 * account ids (normalizeAgentIdStrict), so "BIZ", " biz ", and "biz" address
 * the same account; comparisons must use the canonical form while authored
 * match fields stay untouched. Omitted/empty ids address the default row.
 */
function canonicalAccountId(value: string): string {
  const normalized = normalizeAgentIdStrict(value);
  return normalized.ok ? normalized.value : value.trim();
}

/** Channel identities are trimmed and lowercased by the runtime routing
 * index, so " Telegram " and "telegram" address the same channel. */
function canonicalChannelId(value: string): string {
  return value.trim().toLowerCase();
}

/** Wildcard detection trims the authored pattern (" * " is channel-wide). */
function isWildcardAccountId(value: unknown): boolean {
  return typeof value === "string" && value.trim() === WILDCARD_ACCOUNT;
}

function rowAccountId(binding: RouteBinding): string {
  const accountId = binding.match?.accountId;
  return typeof accountId === "string" && accountId.trim()
    ? canonicalAccountId(accountId)
    : DEFAULT_ACCOUNT_ID;
}

function isChannelAccountBinding(binding: unknown, channelId: string): binding is RouteBinding {
  if (!isRecord(binding) || !isRecord(binding.match)) {
    return false;
  }
  if (canonicalChannelId(String(binding.match.channel)) !== canonicalChannelId(channelId)) {
    return false;
  }
  const type = binding.type;
  if (type !== undefined && type !== "route") {
    return false;
  }
  // Runtime normalizes empty scope constraints to absent: blank guild/team
  // ids and an empty roles array keep a binding account-level.
  const blankConstraint = (value: unknown) =>
    value === undefined || (typeof value === "string" && !value.trim());
  const noRoles = (value: unknown) =>
    value === undefined || (Array.isArray(value) && value.length === 0);
  return (
    binding.match.peer === undefined &&
    blankConstraint(binding.match.guildId) &&
    blankConstraint(binding.match.teamId) &&
    noRoles(binding.match.roles)
  );
}

/**
 * Accounts the editor offers rows for: the configured accounts map unioned
 * with the runtime's live account roster. The runtime keeps an implicit
 * `default` account active whenever named accounts coexist with root or
 * environment credentials (e.g. Discord), so the snapshot roster — not the
 * config map alone — decides which accounts are addressable.
 */
export function readChannelAccounts(
  configValue: Record<string, unknown> | null,
  channelId: string,
  runtimeAccountIds: string[] = [],
): string[] {
  const channels = isRecord(configValue?.channels) ? configValue.channels : {};
  const channel = isRecord(channels[channelId]) ? channels[channelId] : {};
  const accounts = channel.accounts;
  const configured = isRecord(accounts)
    ? Object.keys(accounts).filter((key) => key.trim().length > 0)
    : [];
  const roster: string[] = [];
  const seen = new Set<string>();
  for (const accountId of [...configured, ...runtimeAccountIds]) {
    if (!accountId.trim()) {
      continue;
    }
    const canonical = canonicalAccountId(accountId);
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    roster.push(accountId);
  }
  return roster.length > 0 ? roster : [DEFAULT_ACCOUNT_ID];
}

/** Agent ids available as routing targets. */
export function readAgentIds(configValue: Record<string, unknown> | null): string[] {
  const agents = isRecord(configValue?.agents) ? configValue.agents : {};
  const entries = isRecord(agents.entries) ? agents.entries : {};
  const ids = Object.keys(entries).filter((id) => id.trim().length > 0);
  return ids.length > 0 ? ids : ["main"];
}

/** Account-level route bindings for one channel (peer-scoped and acp bindings untouched). */
export function readChannelRouteBindings(
  configValue: Record<string, unknown> | null,
  channelId: string,
): RouteBinding[] {
  const bindings = Array.isArray(configValue?.bindings) ? (configValue.bindings as unknown[]) : [];
  return bindings.filter((binding) => isChannelAccountBinding(binding, channelId));
}

type EffectiveAgent = { agentId: string | null; viaWildcard: boolean };

/** The agent an account resolves to: its own binding, else the channel wildcard. */
export function resolveAccountAgent(bindings: RouteBinding[], accountId: string): EffectiveAgent {
  const rowId = canonicalAccountId(accountId);
  const specific = bindings.find((binding) => rowAccountId(binding) === rowId);
  if (specific && typeof specific.agentId === "string" && specific.agentId) {
    return { agentId: specific.agentId, viaWildcard: false };
  }
  const wildcard = bindings.find((binding) => isWildcardAccountId(binding.match?.accountId));
  if (wildcard && typeof wildcard.agentId === "string" && wildcard.agentId) {
    return { agentId: wildcard.agentId, viaWildcard: true };
  }
  return { agentId: null, viaWildcard: false };
}

/**
 * Patches exactly one account-level binding for the channel. Every other
 * binding — other accounts (including accounts absent from the rendered
 * rows), peer/acp bindings, session scopes, comments — is preserved
 * byte-for-byte. Changing the agent on an existing binding keeps its
 * non-agent fields (including an omitted-accountId match shape); clearing
 * the agent removes only that row's binding.
 */
export function patchAccountBinding(params: {
  configValue: Record<string, unknown> | null;
  channelId: string;
  /** Row id: an account key, DEFAULT_ACCOUNT_ID, or WILDCARD_ACCOUNT. */
  accountId: string;
  /** Chosen agent id; empty clears the row's binding. */
  agentId: string;
}): Array<Record<string, unknown>> {
  const bindings: unknown[] = Array.isArray(params.configValue?.bindings)
    ? [...(params.configValue.bindings as unknown[])]
    : [];
  const rowId = canonicalAccountId(params.accountId);
  const index = bindings.findIndex(
    (binding) =>
      isChannelAccountBinding(binding, params.channelId) && rowAccountId(binding) === rowId,
  );
  const agentId = params.agentId.trim();
  if (!agentId) {
    if (index >= 0) {
      bindings.splice(index, 1);
    }
    return bindings as Array<Record<string, unknown>>;
  }
  if (index >= 0) {
    const previous = bindings[index] as RouteBinding;
    // Only the agent changes: session scopes, comments, and the match shape
    // (including omitted-accountId default bindings) survive intact.
    bindings[index] = { ...previous, agentId };
    return bindings as Array<Record<string, unknown>>;
  }
  const binding: Record<string, unknown> = {
    agentId,
    match: { channel: params.channelId, accountId: params.accountId },
  };
  // Keep specific bindings ahead of this channel's wildcard so the catch-all
  // stays a fallback (runtime match order); otherwise append at the end.
  let insertAt = bindings.length;
  const wildcardIndex = bindings.findIndex(
    (candidate) =>
      isChannelAccountBinding(candidate, params.channelId) &&
      isWildcardAccountId((candidate as RouteBinding).match?.accountId),
  );
  if (wildcardIndex >= 0) {
    insertAt = wildcardIndex;
  }
  bindings.splice(insertAt, 0, binding);
  return bindings as Array<Record<string, unknown>>;
}

export function renderChannelAgentRoutingSection(params: {
  channelId: string;
  props: ChannelsProps;
}) {
  const { channelId, props } = params;
  // Form patches must build on the same draft the shared configuration owner
  // selects: a dirty raw-mode draft is authoritative, and building the
  // replacement array on the stale parsed form would discard pending raw
  // edits. An unparseable raw draft blocks form edits entirely.
  const configValue = resolveConfigDraftBase(props.config);
  const rawDraftBlocked = configValue === null;
  const runtimeAccountIds = resolveChannelAccounts(
    props.channels.channelsSnapshot?.channelAccounts,
    channelId,
  )
    .map((account) => account.accountId)
    .filter((accountId) => typeof accountId === "string");
  const accounts = readChannelAccounts(configValue, channelId, runtimeAccountIds);
  const agentIds = readAgentIds(configValue);
  const bindings = readChannelRouteBindings(configValue, channelId);
  const disabled = props.config.configSaving || props.config.configSchemaLoading || rawDraftBlocked;

  const rows = [
    ...accounts.map((accountId) => ({ accountId, catchAll: false })),
    { accountId: WILDCARD_ACCOUNT, catchAll: true },
  ];
  const update = (accountId: string, agentId: string) => {
    props.onConfigPatch(
      ["bindings"],
      patchAccountBinding({ configValue, channelId, accountId, agentId }),
    );
  };

  return html`
    <div class="settings-section">
      <h3 class="settings-section__title">${t("channels.routing.title")}</h3>
      <p class="settings-section__desc">${t("channels.routing.description")}</p>
      ${rows.map(({ accountId, catchAll }) => {
        const effective = resolveAccountAgent(bindings, accountId);
        const selected = catchAll
          ? (resolveAccountAgent(bindings, WILDCARD_ACCOUNT).agentId ?? "")
          : (effective.agentId ?? "");
        const title = catchAll
          ? t("channels.routing.catchAll")
          : accountId === DEFAULT_ACCOUNT_ID
            ? t("channels.routing.defaultAccount")
            : accountId;
        return html`
          <div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__title">${title}</span>
              <span class="settings-row__desc">
                ${!catchAll && effective.viaWildcard ? t("channels.routing.viaCatchAll") : ""}
              </span>
            </div>
            <div class="settings-row__control">
              <select
                class="settings-input"
                aria-label=${t("channels.routing.agentFor", { account: title })}
                ?disabled=${disabled}
                @change=${(event: Event) => {
                  update(accountId, (event.currentTarget as HTMLSelectElement).value);
                }}
              >
                <option value="" ?selected=${selected === ""}>
                  ${t("channels.routing.notSet")}
                </option>
                ${agentIds.map(
                  (agentId) => html`
                    <option
                      value=${agentId}
                      ?selected=${selected && canonicalAccountId(selected) === canonicalAccountId(agentId)}
                    >
                      ${agentId}
                    </option>
                  `,
                )}
              </select>
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

export const __keepNothing = nothing;
