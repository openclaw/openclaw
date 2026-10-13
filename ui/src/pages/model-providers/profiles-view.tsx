import "./account-usage.tsx";
import { createMemo, For, onCleanup, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { moveArrayEntry, type ArrayDropPosition } from "../../lib/array-order.ts";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";
import type { ModelAccountUsageElement } from "./account-usage.tsx";
import { modelProviderErrorMessage } from "./config-mutation.ts";
import type { ModelProviderCard, ModelProviderPendingLogout } from "./data.ts";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-model-account-usage": HTMLAttributes<ModelAccountUsageElement> & {
        "prop:client": GatewayBrowserClient | null;
        "prop:agentId": string;
        "prop:profileId": string;
      };
    }
  }
}

registerEnglishCatalog(registerSettingsEnglish);

export function showProfileActionError(error: unknown): void {
  showToast({
    placement: "bottom",
    message: modelProviderErrorMessage(error),
    icon: icons.alertTriangle,
    durationMs: 12_000,
  });
}

export function showProfileLogoutSuccess(warning?: string): void {
  showToast({
    placement: "bottom",
    message: [t("modelProviders.logout.done"), warning].filter(Boolean).join(" "),
    icon: icons.check,
  });
}

type ProviderProfile = ModelProviderCard["profiles"][number];

export type ProviderProfilesViewProps = {
  usageClient?: GatewayBrowserClient | null;
  usageAgentId?: string;
  busy: Record<string, boolean>;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  profileOrders: Record<string, string[]>;
  onAddAccount: (() => void) | undefined;
  addAccountDisabled: boolean;
  onProfileOrderChange: (cardId: string, provider: string, profileIds: string[] | null) => void;
  onRequestLogout: (pending: ModelProviderPendingLogout) => void;
};

const DRAGGING_CLASS = "model-providers__profile--dragging";
const SORTING_CLASS = "model-providers__profiles--sorting";
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

function profileStatus(profile: ProviderProfile, providerAuthRejected: boolean) {
  const status =
    profile.externallyManaged && (profile.status === "expired" || profile.status === "expiring")
      ? "ok"
      : profile.status;
  switch (status) {
    case "ok":
      return (
        <SettingsStatus
          kind={providerAuthRejected ? "muted" : "ok"}
          label={t(
            providerAuthRejected ? "modelProviders.status.configured" : "modelProviders.status.ok",
          )}
        />
      );
    case "static":
      return <SettingsStatus kind={"ok"} label={t("modelProviders.status.configured")} />;
    case "expiring":
      return <SettingsStatus kind={"warn"} label={t("modelProviders.status.expiring")} />;
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

function startPointerDrag(params: {
  event: PointerEvent;
  canMove: boolean;
  provider: string;
  move: (targetId: string, position: ArrayDropPosition) => void;
}): (() => void) | undefined {
  if (!params.canMove || params.event.button !== 0) {
    return undefined;
  }
  const grip = params.event.currentTarget;
  if (!(grip instanceof HTMLElement)) {
    return undefined;
  }
  const row = grip.closest<HTMLElement>(".model-providers__profile");
  const section = grip.closest<HTMLElement>(".model-providers__profiles");
  if (!row || !section) {
    return undefined;
  }
  const sectionTop = section.getBoundingClientRect().top;
  // Use the original slots for hit testing. Measuring animated neighbors would
  // make the insertion point oscillate as they move out from under the pointer.
  const slots = [...section.querySelectorAll<HTMLElement>(".model-providers__profile")]
    .filter((candidate) => candidate.dataset.profileProvider === params.provider)
    .map((element) => ({ element, bounds: element.getBoundingClientRect() }));
  const source = slots.find((slot) => slot.element === row);
  if (!source) {
    return undefined;
  }
  const others = slots.filter((slot) => slot !== source);
  let target: (typeof slots)[number] | undefined;
  let position: ArrayDropPosition = "before";
  params.event.preventDefault();
  section.classList.add(SORTING_CLASS);
  row.classList.add(DRAGGING_CLASS);
  try {
    grip.setPointerCapture?.(params.event.pointerId);
  } catch {
    // Synthetic pointers can lack the active pointer required for capture.
  }

  const update = (event: PointerEvent) => {
    if (event.pointerId !== params.event.pointerId) {
      return;
    }
    const scrollOffset = sectionTop - section.getBoundingClientRect().top;
    const deltaY = event.clientY - params.event.clientY + scrollOffset;
    row.style.translate = `${event.clientX - params.event.clientX}px ${deltaY}px`;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const hitRow = hit?.closest<HTMLElement>(".model-providers__profile");
    const pointerY = event.clientY + scrollOffset;
    const inside =
      hit &&
      section.contains(hit) &&
      (!hitRow || hitRow.dataset.profileProvider === params.provider) &&
      slots.some(
        ({ bounds }) =>
          event.clientX >= bounds.left &&
          event.clientX <= bounds.right &&
          pointerY >= bounds.top &&
          pointerY <= bounds.bottom,
      );
    // Swap as the leading edge crosses a neighbor's center, without requiring
    // the dragged row to travel a full slot before the neighbor makes room.
    const leadingY = (deltaY > 0 ? source.bounds.bottom : source.bounds.top) + deltaY;
    target = inside
      ? others.find(({ bounds }) => leadingY < bounds.top + bounds.height / 2)
      : undefined;
    position = target ? "before" : "after";
    if (inside && !target) {
      target = others.at(-1);
    }
    const preview = target ? moveArrayEntry(slots, source, target, position) : slots;
    if (preview.indexOf(source) === slots.indexOf(source)) {
      target = undefined;
    }
    let top = slots[0]?.bounds.top ?? 0;
    for (const slot of preview) {
      if (slot !== source) {
        slot.element.style.translate = `0px ${top - slot.bounds.top}px`;
      }
      top += slot.bounds.height;
    }
  };
  let active = true;
  const cleanup = () => {
    if (!active) {
      return;
    }
    active = false;
    grip.removeEventListener("pointermove", update);
    grip.removeEventListener("pointerup", handleUp);
    grip.removeEventListener("pointercancel", handleCancel);
    grip.removeEventListener("lostpointercapture", handleCancel);
    document.removeEventListener("keydown", handleKeyDown, true);
    section.classList.remove(SORTING_CLASS);
    for (const { element } of slots) {
      element.classList.remove(DRAGGING_CLASS);
      element.style.removeProperty("translate");
    }
    try {
      grip.releasePointerCapture?.(params.event.pointerId);
    } catch {
      // Pointer cancellation may release capture before this cleanup runs.
    }
  };
  const finish = (event: PointerEvent, apply: boolean) => {
    if (!active || event.pointerId !== params.event.pointerId) {
      return;
    }
    update(event);
    const targetId = target?.element.dataset.profileId;
    cleanup();
    if (apply && targetId) {
      params.move(targetId, position);
    }
  };
  const handleUp = (event: PointerEvent) => finish(event, true);
  const handleCancel = (event: PointerEvent) => finish(event, false);
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(params.event, false);
    }
  };
  grip.addEventListener("pointermove", update);
  grip.addEventListener("pointerup", handleUp);
  grip.addEventListener("pointercancel", handleCancel);
  grip.addEventListener("lostpointercapture", handleCancel);
  // A drag owns Escape before the Settings shell handles its back shortcut.
  document.addEventListener("keydown", handleKeyDown, true);
  return cleanup;
}

function profileIdentity(profile: ProviderProfile, index: number): string {
  return (
    profile.email ||
    profile.displayName ||
    t("modelProviders.profiles.account", { number: String(index + 1) })
  );
}

function ProfileIdentity(props: {
  profile: ProviderProfile;
  identity: string;
  showDetails: boolean;
}) {
  const meta = () => profileMeta(props.profile);
  return (
    <>
      <span class="model-providers__profile-avatar" aria-hidden="true">
        {profileInitials(props.identity)}
      </span>
      <div class="model-providers__profile-copy">
        <strong>{props.identity}</strong>
        {meta() ? <span>{meta()}</span> : undefined}
        <Show when={props.showDetails}>
          <details>
            <summary>{t("modelProviders.profiles.details")}</summary>
            <div>{props.profile.profileId}</div>
            {props.profile.expiry ? (
              <span>{t("modelProviders.expiresIn", { time: props.profile.expiry.label })}</span>
            ) : undefined}
          </details>
        </Show>
      </div>
    </>
  );
}

export function renderProviderAccountSummary(
  cards: ModelProviderCard[],
  recovery?: {
    authProvider: string;
    disabled: boolean;
    onUse: (profileId: string) => void;
  },
) {
  const profiles = cards.flatMap((card) =>
    card.profiles.map((profile) => ({
      profile,
      authRejected: card.catalogStatus === "auth-rejected",
      // A display card can combine providers whose credentials are not interchangeable.
      canUse:
        card.profileProviderIds[profile.profileId] === recovery?.authProvider &&
        (profile.source === "saved" || profile.source === "inherited"),
    })),
  );
  const sources = [...new Set(cards.map(apiKeySource).filter(Boolean))];
  return (
    <section class="model-provider-login__accounts" aria-label={t("modelProviders.login.accounts")}>
      <h3>{t("modelProviders.login.accounts")}</h3>
      {profiles.length ? (
        <div role="list">
          <For each={profiles}>
            {(entry, index) => (
              <div
                class="model-provider-login__account"
                role="listitem"
                data-profile-id={entry.profile.profileId}
              >
                <ProfileIdentity
                  profile={entry.profile}
                  identity={profileIdentity(entry.profile, index())}
                  showDetails={false}
                />
                {profileStatus(entry.profile, entry.authRejected)}
                {entry.canUse && recovery ? (
                  <button
                    class="btn"
                    data-models-use-account
                    disabled={recovery.disabled}
                    onClick={() => recovery.onUse(entry.profile.profileId)}
                  >
                    {t("modelProviders.login.useAccount")}
                  </button>
                ) : undefined}
              </div>
            )}
          </For>
        </div>
      ) : undefined}
      <For each={sources}>{(source) => <p class="muted">{source}</p>}</For>
      {!profiles.length && !sources.length ? (
        <p class="muted">{t("modelProviders.login.noAccounts")}</p>
      ) : undefined}
    </section>
  );
}

export function ProviderProfiles(props: ProviderProfilesViewProps & { card: ModelProviderCard }) {
  const card = () => props.card;
  const groups = createMemo(() => profileGroups(card(), props.profileOrders));
  // Account numbers follow the saved inventory, not the editable priority order.
  const identities = createMemo(
    () =>
      new Map(
        card().profiles.map((profile, index) => [
          profile.profileId,
          profileIdentity(profile, index),
        ]),
      ),
  );
  const rows = createMemo(() =>
    groups().flatMap((group) => group.profiles.map((profile) => ({ group, profile }))),
  );
  const reorderOffered = () =>
    groups().some((group) => !group.lock && group.complete && group.order.length > 1);
  const explanations = () => [
    ...new Set(groups().flatMap((group) => (group.explanation ? [group.explanation] : []))),
  ];
  const additionalCredentialSource = () => apiKeySource(card());
  return (
    <Show when={card().profiles.length > 0}>
      <section
        class="model-providers__profiles"
        aria-label={`${t("modelProviders.profiles.title")}: ${card().displayName}`}
      >
        <div class="model-providers__profiles-heading">
          <div class="model-providers__profiles-heading-copy">
            <strong>{t("modelProviders.profiles.title")}</strong>
            <span>
              {t(
                rows().length === 1
                  ? "modelProviders.profiles.accountOne"
                  : "modelProviders.profiles.accounts",
                { count: String(rows().length) },
              )}
              {additionalCredentialSource() ? ` · ${additionalCredentialSource()}` : ""}
            </span>
            {reorderOffered() ? <span>{t("modelProviders.profiles.reorderHint")}</span> : undefined}
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
            {props.onAddAccount ? (
              <button
                type="button"
                class="btn btn--sm"
                disabled={props.addAccountDisabled}
                onClick={() => props.onAddAccount?.()}
              >
                {t("modelProviders.profiles.addAccount")}
              </button>
            ) : undefined}
          </div>
        </div>
        <div class="model-providers__profile-list" role="list">
          <For each={rows()} keyed={(row) => row.profile.profileId}>
            {(row) => (
              <ProviderProfileRow
                {...props}
                row={row()}
                identity={identities().get(row().profile.profileId)!}
              />
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}

function ProviderProfileRow(
  props: ProviderProfilesViewProps & {
    row: { profile: ProviderProfile; group: ReturnType<typeof profileGroups>[number] };
    card: ModelProviderCard;
    identity: string;
  },
) {
  let cancelDrag: (() => void) | undefined;
  onCleanup(() => cancelDrag?.());
  const profile = () => props.row.profile;
  const group = () => props.row.group;
  const provider = () => group().provider;
  const order = () => group().order;
  const index = () => order().indexOf(profile().profileId);
  const canMove = () =>
    props.canMutate && !group().lock && group().complete && order().length > 1 && index() >= 0;
  const showMoves = () =>
    !group().lock && (group().complete || group().stored) && order().length > 1;
  const logoutProvider = () =>
    props.card.logoutTargets.find((target) => target.profileIds.includes(profile().profileId))
      ?.provider;
  const logoutLabel = () => t("modelProviders.logout.actionFor", { account: props.identity });
  const logoutBlocked = () =>
    !props.canMutate ? (props.mutationBlockedReason ?? "") : logoutLabel();
  const reorderBlocked = () =>
    !props.canMutate ? (props.mutationBlockedReason ?? "") : (group().explanation ?? "");
  const reorder = (targetId: string, position: ArrayDropPosition) => {
    if (canMove()) {
      props.onProfileOrderChange(
        props.card.id,
        provider(),
        moveArrayEntry(order(), profile().profileId, targetId, position),
      );
    }
  };
  const move = (event: Event, delta: -1 | 1) => {
    const targetId = order()[index() + delta];
    if (!canMove() || !targetId) {
      return;
    }
    const control = event.currentTarget;
    const restoreFocus = control instanceof HTMLButtonElement && document.activeElement === control;
    reorder(targetId, delta < 0 ? "before" : "after");
    if (restoreFocus) {
      // Keep keyboard focus after keyed rows move
      // on this account so the next move still acts on the same row.
      queueMicrotask(() => {
        if (control.isConnected && document.activeElement === document.body) {
          control.focus({ preventScroll: true });
        }
      });
    }
  };
  return (
    <div
      class="model-providers__profile"
      role="listitem"
      data-profile-id={profile().profileId}
      data-profile-provider={provider()}
    >
      <span class="model-providers__profile-order">
        {showMoves() ? (
          <button
            type="button"
            class="model-providers__profile-grip"
            disabled={!canMove()}
            aria-label={t("modelProviders.profiles.reorder", {
              account: props.identity,
              position: String(index() + 1),
            })}
            aria-keyshortcuts={canMove() ? "ArrowUp ArrowDown" : undefined}
            title={reorderBlocked() || t("modelProviders.profiles.reorderHint")}
            onPointerDown={(event: PointerEvent) => {
              cancelDrag?.();
              cancelDrag = startPointerDrag({
                event,
                canMove: canMove(),
                provider: provider(),
                move: reorder,
              });
            }}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                move(event, event.key === "ArrowUp" ? -1 : 1);
              }
            }}
          >
            <Icon name="gripVertical" />
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
        {group().explicit && group().complete && index() >= 0 ? (
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
      <ProfileIdentity profile={profile()} identity={props.identity} showDetails />
      {provider() === "openai" && profile().type !== "api_key" ? (
        <openclaw-model-account-usage
          prop:client={props.usageClient ?? null}
          prop:agentId={props.usageAgentId ?? ""}
          prop:profileId={profile().profileId}
        />
      ) : undefined}
      <span class="model-providers__profile-status">
        {profileStatus(profile(), props.card.catalogStatus === "auth-rejected")}
      </span>
      <span class="model-providers__profile-actions">
        {profile().logoutSupported === true && logoutProvider() ? (
          <button
            type="button"
            class="model-providers__profile-logout"
            aria-label={logoutLabel()}
            title={logoutBlocked()}
            disabled={!props.canMutate || props.busy[`logout:${props.card.id}`]}
            onClick={() => {
              const targetProvider = logoutProvider();
              if (targetProvider) {
                props.onRequestLogout({
                  cardId: props.card.id,
                  label: props.identity,
                  target: { provider: targetProvider, profileIds: [profile().profileId] },
                });
              }
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" x2="9" y1="12" y2="12" />
            </svg>
          </button>
        ) : undefined}
      </span>
    </div>
  );
}
