import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, mapArray, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { StrokeIcon } from "../../components/solid/stroke-icon.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { moveArrayEntry } from "../../lib/array-order.ts";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { isAccessTokenExpiry, isOAuthRefreshPending } from "../../lib/model-auth.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { createPointerDrag } from "../../lib/reactive/pointer-drag.ts";
import { showToast } from "../../lib/toast.ts";
import { AccountUsageBars } from "./account-usage-bars.tsx";
import {
  AccountLimits,
  createAccountUsage,
  type AccountUsageRead,
  type AccountUsageScope,
} from "./account-usage.tsx";
import { modelProviderErrorMessage } from "./config-mutation.ts";
import type { ModelProviderCard, ModelProviderPendingLogout } from "./data.ts";
import { reorderByArrow, startProfileRowDrag } from "./profile-reorder.ts";
import {
  needsOAuthSignIn,
  profileAuthProblem,
  providerStatusCoversAccount,
} from "./view-status.tsx";

registerEnglishCatalog(registerSettingsEnglish);

export function showProfileActionError(error: unknown): void {
  showToast({
    message: modelProviderErrorMessage(error),
    severity: "error",
    durationMs: 12_000,
  });
}

export function showProfileActionWarning(warning: string): void {
  showToast({
    message: formatUiExternalText(warning),
    severity: "warning",
    durationMs: 12_000,
  });
}

export function showProfileLogoutSuccess(warning?: string): void {
  // The account disappearing already confirms success; warnings still need attention.
  if (!warning) {
    return;
  }
  showToast({
    message: warning,
    severity: "warning",
  });
}

type ProviderProfile = ModelProviderCard["profiles"][number];

export type ProviderProfilesViewProps = {
  /** Present when this operator may read per-account Codex limits. */
  accountUsage?: AccountUsageScope | null;
  busy: Record<string, boolean>;
  logoutSaving?: Record<string, boolean>;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  profileOrders: Record<string, string[]>;
  onProfileOrderChange: (cardId: string, provider: string, profileIds: string[] | null) => void;
  onRequestLogout: (pending: ModelProviderPendingLogout) => void;
  /** A provider sign-in is open or settling; only one runs at a time. */
  loginBusy?: boolean;
  /** Whether this provider offers a sign-in the Models page can start. */
  canSignInAgain?: () => boolean;
  /**
   * Starts the provider's existing sign-in. The same account signs in under its
   * existing profile id, replacing the failed grant; another account adds a row.
   */
  onSignInAgain?: () => void;
};

const PROFILE_SOURCE_LABELS = new Map([
  ["config", "modelProviders.profiles.sourceConfig"],
  ["inherited", "modelProviders.profiles.sourceInherited"],
  ["saved", "modelProviders.profiles.sourceSaved"],
]);

export function apiKeySource(card: ModelProviderCard): string | undefined {
  if (card.apiKey?.source === "config") {
    return t("modelProviders.credentials.configKey");
  }
  if (card.apiKey?.source !== "env") {
    return undefined;
  }
  return card.apiKey.envVar
    ? t("modelProviders.credentials.envKeyNamed", { name: card.apiKey.envVar })
    : t("modelProviders.credentials.envKey");
}

function profileMeta(profile: ProviderProfile): string {
  const parts: string[] = [];
  const sourceKey = PROFILE_SOURCE_LABELS.get(profile.source ?? "");
  const source =
    profile.source === "external"
      ? profile.displayName || t("modelProviders.profiles.sourceExternal")
      : sourceKey
        ? t(sourceKey)
        : undefined;
  if (source && profile.source !== "saved") {
    parts.push(source);
  }
  if (profile.email && profile.displayName && profile.displayName !== source) {
    parts.push(profile.displayName);
  }
  if (profile.expiry) {
    parts.push(
      t(
        profile.type === "oauth"
          ? profile.status === "expired"
            ? "modelProviders.accessTokenExpired"
            : "modelProviders.accessTokenExpiresIn"
          : "modelProviders.expiresIn",
        { time: profile.expiry.label },
      ),
    );
  }
  if (profile.lastUsedAt) {
    parts.push(
      t("modelProviders.profiles.lastUsed", {
        time: formatDurationHuman(Date.now() - profile.lastUsedAt),
      }),
    );
  }
  return parts.join(" · ");
}

function profileInitials(identity: string): string {
  const localPart = identity.split("@")[0] ?? "";
  const words = localPart.split(/[^a-z0-9]+/iu).filter(Boolean);
  const initials =
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}`
      : (words[0]?.slice(0, 2) ?? "");
  return initials.toLocaleUpperCase() || "?";
}

/** `quiet` keeps only an account's own problem; the provider row reports everything else. */
function profileStatus(profile: ProviderProfile, providerAuthRejected: boolean, quiet = false) {
  const problem = profileAuthProblem(profile);
  if (problem) {
    return <SettingsStatus kind="danger" label={t(problem)} />;
  }
  if (isOAuthRefreshPending(profile)) {
    return <SettingsStatus kind="muted" label={t("modelProviders.status.refreshing")} />;
  }
  if (
    isAccessTokenExpiry(profile) ||
    (profile.externallyManaged && (profile.status === "expired" || profile.status === "expiring"))
  ) {
    return quiet ? undefined : (
      <SettingsStatus
        kind="muted"
        label={t(
          profile.externallyManaged
            ? "modelProviders.status.managedExternally"
            : "modelProviders.status.configured",
        )}
      />
    );
  }
  switch (profile.status) {
    case "ok":
      if (quiet) {
        return undefined;
      }
      return (
        <SettingsStatus
          kind={providerAuthRejected ? "muted" : "ok"}
          label={t(
            providerAuthRejected ? "modelProviders.status.configured" : "modelProviders.status.ok",
          )}
        />
      );
    case "static":
      return quiet ? undefined : (
        <SettingsStatus kind={"ok"} label={t("modelProviders.status.configured")} />
      );
    case "expiring":
      // Its meta line already says when, and the provider row already says "Expiring".
      return quiet && profile.expiry ? undefined : (
        <SettingsStatus kind={"warn"} label={t("modelProviders.status.expiring")} />
      );
    case "expired":
      return <SettingsStatus kind={"danger"} label={t("modelProviders.status.expired")} />;
    default:
      return <SettingsStatus kind={"muted"} label={t("modelProviders.status.missing")} />;
  }
}

function profileGroups(card: ModelProviderCard, drafts: Record<string, string[]>) {
  const providers = new Set(
    card.profiles.map((profile) => card.profileProviderIds[profile.profileId] ?? card.id),
  );
  return [...providers].map((provider) => {
    const profiles = card.profiles.filter(
      (profile) => (card.profileProviderIds[profile.profileId] ?? card.id) === provider,
    );
    const order = drafts[provider] ?? card.profileOrders[provider] ?? [];
    const remaining = new Map(profiles.map((profile) => [profile.profileId, profile]));
    const ordered = order.flatMap((profileId) => {
      const profile = remaining.get(profileId);
      remaining.delete(profileId);
      return profile ? [profile] : [];
    });
    const complete = order.length === profiles.length && ordered.length === profiles.length;
    const lock = card.profileOrderLocks[provider];
    const stored = card.profileOrderStoredProviders.includes(provider);
    const explicit =
      drafts[provider] !== undefined || card.profileOrderExplicitProviders.includes(provider);
    const explanation = lock
      ? t(
          lock === "auth-config"
            ? "modelProviders.profiles.priorityManagedByAuth"
            : "modelProviders.profiles.priorityManagedByProvider",
        )
      : !complete
        ? t(
            stored
              ? "modelProviders.profiles.partialStoredOrder"
              : "modelProviders.profiles.partialOrder",
          )
        : undefined;
    return {
      provider,
      order,
      lock,
      complete,
      stored,
      explicit,
      explanation,
      profiles: [...ordered, ...remaining.values()],
    };
  });
}

const PROFILE_KIND_KEYS = {
  api_key: "modelProviders.profiles.kindApiKey",
  token: "modelProviders.profiles.kindToken",
  oauth: "modelProviders.profiles.kindOauth",
} as const;

// Identities stay hidden from non-admin viewers; name the credential kind instead
// of an opaque "Account N". Numbers follow saved inventory order within a kind.
export function profileIdentity(
  profile: ProviderProfile,
  profiles: readonly ProviderProfile[],
): string {
  const named = profile.email || profile.displayName;
  if (named) {
    return named;
  }
  const kind = t(PROFILE_KIND_KEYS[profile.type]);
  const sameKind = profiles.filter(
    (candidate) => candidate.type === profile.type && !candidate.email && !candidate.displayName,
  );
  return sameKind.length > 1
    ? t("modelProviders.profiles.kindNumbered", {
        kind,
        number: String(sameKind.indexOf(profile) + 1),
      })
    : kind;
}

function ProfileIdentity(props: { profile: ProviderProfile; identity: string; avatar?: boolean }) {
  const meta = () => profileMeta(props.profile);
  return (
    <>
      <Show when={props.avatar}>
        <span class="model-providers__profile-avatar" aria-hidden="true">
          {props.profile.type === "oauth" ? profileInitials(props.identity) : <Icon name="key" />}
        </span>
      </Show>
      <div class="model-providers__profile-copy">
        <strong title={props.profile.profileId}>{props.identity}</strong>
        {meta() ? <span>{meta()}</span> : undefined}
        {isAccessTokenExpiry(props.profile) ? (
          <span>{t("modelProviders.accessTokenExpiryHelp")}</span>
        ) : undefined}
      </div>
    </>
  );
}

/** Whether a provider has a saved account or key worth listing before the ways to add one. */
export function hasProviderAccounts(cards: ModelProviderCard[]) {
  return cards.some((card) => card.profiles.length > 0 || Boolean(apiKeySource(card)));
}

export function ProviderAccountSummary(props: {
  cards: ModelProviderCard[];
  recovery?: {
    authProvider: string;
    disabled: boolean;
    onUse: (profileId: string) => void;
  };
}) {
  const profiles = createMemo(() =>
    props.cards.flatMap((card) =>
      card.profiles.map((profile) => ({
        key: JSON.stringify([
          card.id,
          card.profileProviderIds[profile.profileId],
          profile.profileId,
        ]),
        profile,
        authRejected: card.catalogStatus === "auth-rejected",
        // A display card can combine providers whose credentials are not interchangeable.
        canUse:
          card.profileProviderIds[profile.profileId] === props.recovery?.authProvider &&
          (profile.source === "saved" || profile.source === "inherited"),
      })),
    ),
  );
  const sources = createMemo(() => [...new Set(props.cards.map(apiKeySource).filter(Boolean))]);
  return (
    <section class="model-provider-login__accounts" aria-label={t("modelProviders.login.accounts")}>
      <h3>{t("modelProviders.login.accounts")}</h3>
      {profiles().length ? (
        <div role="list">
          <For each={profiles()} keyed={(entry) => entry.key}>
            {(entry) => (
              <div
                class="model-provider-login__account"
                role="listitem"
                data-profile-id={entry().profile.profileId}
              >
                <ProfileIdentity
                  avatar
                  profile={entry().profile}
                  identity={profileIdentity(
                    entry().profile,
                    profiles().map((candidate) => candidate.profile),
                  )}
                />
                {profileStatus(entry().profile, entry().authRejected)}
                {entry().canUse && props.recovery ? (
                  <button
                    class="btn"
                    data-models-use-account
                    disabled={props.recovery.disabled}
                    onClick={() => props.recovery?.onUse(entry().profile.profileId)}
                  >
                    {t("modelProviders.login.useAccount")}
                  </button>
                ) : undefined}
              </div>
            )}
          </For>
        </div>
      ) : undefined}
      <For each={sources()}>{(source) => <p class="muted">{source}</p>}</For>
      {!profiles().length && !sources().length ? (
        <p class="muted">{t("modelProviders.login.noAccounts")}</p>
      ) : undefined}
    </section>
  );
}

export function ProviderProfiles(
  props: ProviderProfilesViewProps & {
    card: ModelProviderCard;
    /** Replaces the key on the provider's only key, when that key is a saved API-key row. */
    keyAction?: () => JSX.Element;
  },
) {
  const card = () => props.card;
  const groups = createMemo(() => profileGroups(card(), props.profileOrders));
  // Account numbers follow the saved inventory, not the editable priority order.
  const identity = (profile: ProviderProfile) => profileIdentity(profile, card().profiles);
  const rows = createMemo(() =>
    groups().flatMap((group) => group.profiles.map((profile) => ({ group, profile }))),
  );
  const subscriptionGroup = createMemo(() => groups().find((group) => group.provider === "openai"));
  const readings = mapArray(
    () => {
      const scope = props.accountUsage;
      return scope
        ? (subscriptionGroup()?.profiles ?? [])
            .filter((profile) => profile.type !== "api_key")
            .map((profile) => ({ profile, scope }))
        : [];
    },
    (entry) => {
      const name = createMemo(() => identity(entry().profile));
      return {
        ...createAccountUsage(
          () => entry().scope,
          () => entry().profile.profileId,
        ),
        name,
        status: () =>
          profileStatus(entry().profile, card().catalogStatus === "auth-rejected", true),
      };
    },
    { keyed: (entry) => entry.profile.profileId },
  );
  const reads = createMemo(
    () => new Map(readings().map((read) => [read.account().profileId, read])),
  );
  const grouped = () => readings().length > 1;
  const canReorderBars = () =>
    props.canMutate && Boolean(subscriptionGroup()?.complete) && !subscriptionGroup()?.lock;
  const explanations = () => [
    ...new Set(groups().flatMap((group) => (group.explanation ? [group.explanation] : []))),
  ];
  const [expandedAccount, setExpandedAccount] = createSignal<string>();
  const listedRows = createMemo(() =>
    rows().filter(
      ({ profile }) =>
        !grouped() || !reads().has(profile.profileId) || profile.profileId === expandedAccount(),
    ),
  );
  return (
    <Show when={card().profiles.length > 0}>
      <section
        class="model-providers__profiles"
        aria-label={`${t("modelProviders.profiles.title")}: ${card().displayName}`}
      >
        <Show when={explanations().length > 0 || card().profileOrderStoredProviders.length > 0}>
          <div class="model-providers__profiles-heading">
            <div class="model-providers__profiles-heading-copy">
              <For each={explanations()}>{(explanation) => <span>{explanation}</span>}</For>
            </div>
            <div class="model-providers__profiles-heading-actions">
              <For each={card().profileOrderStoredProviders}>
                {(provider) => (
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    disabled={!props.canMutate}
                    title={
                      !props.canMutate
                        ? (props.mutationBlockedReason ?? "")
                        : t("modelProviders.profiles.resetOrderHint")
                    }
                    onClick={() => props.onProfileOrderChange(card().id, provider, null)}
                  >
                    {t("modelProviders.profiles.resetOrder")}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={grouped()}>
          <AccountUsageBars
            readings={readings()}
            expandedAccount={expandedAccount()}
            onToggleAccount={(id) =>
              setExpandedAccount((current) => (current === id ? undefined : id))
            }
            canReorder={canReorderBars()}
            onReorder={(ids) => {
              const group = subscriptionGroup();
              if (!canReorderBars() || !group) {
                return;
              }
              // Other kinds of credentials retain their exact priority slots.
              let next = 0;
              props.onProfileOrderChange(
                card().id,
                group.provider,
                group.order.map((id) => (reads().has(id) ? ids[next++]! : id)),
              );
            }}
          />
        </Show>
        <Show when={listedRows().length}>
          <div class="model-providers__profile-list" role="list">
            <For each={listedRows()} keyed={(row) => row.profile.profileId}>
              {(row) => (
                <ProviderProfileRow
                  {...props}
                  row={row()}
                  usageRead={reads().get(row().profile.profileId)}
                  grouped={grouped() && row().group === subscriptionGroup()}
                  identity={identity(row().profile)}
                />
              )}
            </For>
          </div>
        </Show>
      </section>
    </Show>
  );
}

function ProviderProfileRow(
  props: ProviderProfilesViewProps & {
    row: { profile: ProviderProfile; group: ReturnType<typeof profileGroups>[number] };
    card: ModelProviderCard;
    identity: string;
    usageRead?: AccountUsageRead;
    grouped: boolean;
    keyAction?: () => JSX.Element;
  },
) {
  let rowElement!: HTMLElement;
  const drag = createPointerDrag({ cancelOnEscape: true });
  const profile = () => props.row.profile;
  const group = () => props.row.group;
  const provider = () => group().provider;
  const order = () => group().order;
  const index = () => order().indexOf(profile().profileId);
  const canMove = () =>
    props.canMutate && !group().lock && group().complete && order().length > 1 && index() >= 0;
  const showGrip = () =>
    !props.grouped && !group().lock && (group().complete || group().stored) && order().length > 1;
  // Subscription columns can swap with each other, but not with a key. A key can
  // choose any slot in the full order without needing a visible row to drop on.
  const showKeyPriority = () =>
    props.grouped && profile().type === "api_key" && group().complete && !group().lock;
  const reorderLabel = () =>
    t("modelProviders.profiles.reorder", {
      account: props.identity,
      position: String(index() + 1),
    });
  const positioned = () => group().explicit && group().complete && index() >= 0;
  const firstApiKey = () =>
    profile().type === "api_key" &&
    props.card.profiles.find((candidate) => candidate.type === "api_key") === profile();
  const logoutTarget = () =>
    props.card.logoutTargets.find((target) => target.profileIds.includes(profile().profileId));
  const logoutProvider = () => logoutTarget()?.provider;
  // Providers that declare account actions get the device/provider split as text actions.
  const accountActions = () =>
    profile().type === "oauth" && profile().logoutSupported === true
      ? logoutTarget()?.oauthAccountActions
      : undefined;
  const logoutLabel = () => t("modelProviders.logout.actionFor", { account: props.identity });
  const canSignInAgain = () => needsOAuthSignIn(profile()) && props.canSignInAgain?.() === true;
  const logoutBlocked = () =>
    !props.canMutate ? (props.mutationBlockedReason ?? "") : logoutLabel();
  const logoutDisabled = () =>
    props.logoutSaving?.[props.card.id] ||
    !props.canMutate ||
    props.busy[`logout:${props.card.id}`];
  const requestLogout = (disconnect?: { label: string }) => {
    const targetProvider = logoutProvider();
    if (targetProvider) {
      props.onRequestLogout({
        cardId: props.card.id,
        label: props.identity,
        target: { provider: targetProvider, profileIds: [profile().profileId] },
        ...(disconnect ? { disconnect } : {}),
      });
    }
  };
  const reorderBlocked = () =>
    !props.canMutate ? (props.mutationBlockedReason ?? "") : (group().explanation ?? "");
  const reorder = (targetId: string) => {
    if (canMove()) {
      props.onProfileOrderChange(
        props.card.id,
        provider(),
        moveArrayEntry(order(), profile().profileId, targetId),
      );
    }
  };
  return (
    <div
      class="model-providers__profile"
      ref={(element) => (rowElement = element)}
      role="listitem"
      data-profile-id={profile().profileId}
      data-profile-provider={provider()}
    >
      <Show when={showGrip() || (positioned() && !showKeyPriority())}>
        <span class="model-providers__profile-order">
          {showGrip() ? (
            <button
              type="button"
              class="model-providers__profile-grip"
              disabled={!canMove()}
              aria-label={reorderLabel()}
              aria-keyshortcuts={canMove() ? "ArrowUp ArrowDown" : undefined}
              title={reorderBlocked() || t("modelProviders.profiles.reorderHint")}
              onPointerDown={(event: PointerEvent) => {
                drag.cancel();
                startProfileRowDrag({
                  event,
                  canMove: canMove(),
                  row: rowElement,
                  move: reorder,
                  drag,
                });
              }}
              onKeyDown={(event: KeyboardEvent) => {
                if (canMove()) {
                  reorderByArrow(event, order(), index(), "vertical", reorder);
                }
              }}
            >
              <Icon name="gripVertical" />
            </button>
          ) : undefined}
          {positioned() ? (
            <span
              class="model-providers__profile-position"
              aria-label={t("modelProviders.profiles.priority", {
                position: String(index() + 1),
              })}
              title={t("modelProviders.profiles.priority", {
                position: String(index() + 1),
              })}
            >
              {index() + 1}
            </span>
          ) : undefined}
        </span>
      </Show>
      <ProfileIdentity profile={profile()} identity={props.identity} />
      <span class="model-providers__profile-status">
        {(props.grouped && props.usageRead) || providerStatusCoversAccount(props.card)
          ? undefined
          : profileStatus(profile(), props.card.catalogStatus === "auth-rejected", true)}
      </span>
      <span class="model-providers__profile-actions">
        <Show when={showKeyPriority()}>
          <SettingsSelect
            aria-label={reorderLabel()}
            title={reorderBlocked() || undefined}
            disabled={!canMove()}
            value={String(index())}
            options={order().map((_, slot) => ({
              value: String(slot),
              label: t("modelProviders.profiles.priority", { position: String(slot + 1) }),
            }))}
            onChange={(event) => {
              const slot = event.currentTarget.selectedIndex;
              const target = order()[slot];
              if (target && slot !== index()) {
                reorder(target);
              }
            }}
          />
        </Show>
        {firstApiKey() ? props.keyAction?.() : undefined}
        {canSignInAgain() ? (
          <button
            type="button"
            class="btn btn--sm"
            data-models-sign-in-again={profile().profileId}
            aria-label={t("modelProviders.profiles.signInAgainFor", { account: props.identity })}
            title={!props.canMutate ? (props.mutationBlockedReason ?? "") : ""}
            disabled={!props.canMutate || props.loginBusy}
            onClick={() => props.onSignInAgain?.()}
          >
            {t("modelProviders.profiles.signInAgain")}
          </button>
        ) : undefined}
        {profile().logoutSupported === true && logoutProvider() && !accountActions() ? (
          <button
            type="button"
            class="model-providers__profile-logout"
            aria-label={logoutLabel()}
            title={logoutBlocked()}
            disabled={logoutDisabled()}
            onClick={() => requestLogout()}
          >
            <StrokeIcon>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" x2="9" y1="12" y2="12" />
            </StrokeIcon>
          </button>
        ) : undefined}
      </span>
      <Show when={logoutProvider() ? accountActions() : undefined}>
        {(actions) => {
          const disconnectLabel = () =>
            actions().disconnect?.label || t("modelProviders.disconnect.action");
          return (
            <div class="model-providers__profile-account-actions">
              <button
                type="button"
                class="btn btn--sm"
                aria-label={t("modelProviders.logout.deviceActionFor", { account: props.identity })}
                title={!props.canMutate ? (props.mutationBlockedReason ?? "") : ""}
                disabled={logoutDisabled()}
                onClick={() => requestLogout()}
              >
                {t("modelProviders.logout.deviceAction")}
              </button>
              <Show when={actions().disconnect}>
                <button
                  type="button"
                  class="btn btn--sm danger"
                  aria-label={t("modelProviders.disconnect.actionFor", {
                    action: disconnectLabel(),
                    account: props.identity,
                  })}
                  title={!props.canMutate ? (props.mutationBlockedReason ?? "") : ""}
                  disabled={logoutDisabled()}
                  onClick={() => requestLogout({ label: disconnectLabel() })}
                >
                  {disconnectLabel()}
                </button>
              </Show>
              <Show when={actions().manage}>
                {(manage) => (
                  <a
                    class="model-providers__profile-manage"
                    href={manage().url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {manage().label || t("modelProviders.disconnect.manage")}
                  </a>
                )}
              </Show>
            </div>
          );
        }}
      </Show>
      <Show when={props.usageRead}>
        {(read) => <AccountLimits read={read()} grouped={props.grouped} />}
      </Show>
    </div>
  );
}
