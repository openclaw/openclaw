import type { JSX } from "@solidjs/web";
import { createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
import { SESSION_VISIBILITY_VALUES } from "../../../../../packages/gateway-protocol/src/schema/sessions-sharing-constants.js";
import type { SessionSharingIdentity } from "../../../../../packages/gateway-protocol/src/schema/sessions-sharing.js";
import type { SessionVisibility } from "../../../api/types.ts";
import { PersonName, PersonAvatarLink } from "../../../components/person-activity-link-solid.tsx";
import {
  personActivityLink,
  type PersonActivityRouting,
} from "../../../components/person-activity-link.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { SessionOwnerAvatar } from "../../../components/solid/session-owner-chip.tsx";
import { SettingsToggleRow } from "../../../components/solid/settings-ui.tsx";
import { registerSessionPeopleEnglish } from "../../../i18n/locales/en-session-people.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/settings.css";
import "../../../styles/chat/sharing-mobile.css";

registerEnglishCatalog(registerSessionPeopleEnglish);

export type ChatSessionSharingOptionsProps = {
  visibility: SessionVisibility;
  publicShare: boolean;
  openDisabledReason?: string;
  onOpen: () => void;
};

// People owns placement and eligibility; its host owns the destination and focus.
export function ChatSessionSharingOptions(props: ChatSessionSharingOptionsProps) {
  const value = () =>
    props.publicShare
      ? t("chat.sessionSharing.publicIndicator")
      : t(
          `chat.sessionSharing.${props.visibility === "read-only" ? "readOnly" : props.visibility}`,
        );

  return (
    <button
      type="button"
      class="chat-sharing-options"
      disabled={Boolean(props.openDisabledReason)}
      aria-description={props.openDisabledReason}
      onClick={() => {
        if (!props.openDisabledReason) {
          props.onOpen();
        }
      }}
    >
      <Icon name="sharingOptions" class="chat-sharing-options__icon" />
      <span class="chat-sharing-options__label">{t("chat.sessionSharing.sharingOptions")}</span>
      <span class="chat-sharing-options__value">
        <Show when={props.publicShare}>
          <Icon name="globe" class="chat-sharing-options__public-icon" />
        </Show>
        <span>{value()}</span>
      </span>
      <Icon name="chevronRight" class="chat-sharing-options__chevron" />
    </button>
  );
}

export type ChatSessionSharingMobileLabels = {
  sessionAccess: string;
  linkSharing: string;
  anyoneWithLink: string;
  messagePermissions: string;
  showSearch: string;
  hideSearch: string;
};

export type ChatSessionSharingModePresentation = Record<
  SessionVisibility,
  { description: string; icon: () => JSX.Element }
>;

export type ChatSessionSharingPermissionRow = {
  identity: SessionSharingIdentity;
  permissionLabel: string;
  selected: boolean;
  /** Fixed creator/admin rows remain visible, subdued and non-editable. */
  fixed?: boolean;
  disabledReason?: string;
};

export type ChatSessionSharingMobileProps = {
  visibility: SessionVisibility;
  modes: ChatSessionSharingModePresentation;
  labels: ChatSessionSharingMobileLabels;
  accessDisabledReason?: string;
  onOpenAccess: () => void;
  error?: string;
  publicLink?: {
    enabled: boolean;
    description: string;
    url?: string;
    disabledReason?: string;
    copyDisabledReason?: string;
    /** The native action owns confirmation, current authority and error reporting. */
    onChange: (enabled: boolean) => void;
    onCopy: () => void;
  };
  /** Omitted when the authoritative projection does not expose this section. */
  permissions?: {
    rows: readonly ChatSessionSharingPermissionRow[];
    loading: boolean;
    personActivity?: PersonActivityRouting;
    onMemberChange: (identityId: string, member: boolean) => void;
  };
};

export type ChatSessionAccessMobileProps = {
  visibility: SessionVisibility;
  modes: ChatSessionSharingModePresentation;
  allowedVisibilities: readonly SessionVisibility[];
  label: string;
  pending: boolean;
  disabledReason?: string;
  error?: string;
  /** True only after an applied mutation still belonging to this current destination. */
  onVisibilityChange: (visibility: SessionVisibility) => Promise<boolean>;
  onApplied: () => void;
};

function sharingVisibilityLabel(visibility: SessionVisibility) {
  return t(`chat.sessionSharing.${visibility === "read-only" ? "readOnly" : visibility}`);
}

function SharingDisclosure(props: { open: boolean; children: JSX.Element }) {
  return (
    <div
      class="chat-sharing-mobile__disclosure"
      data-open={props.open ? "true" : "false"}
      aria-hidden={props.open ? undefined : "true"}
      inert={!props.open}
    >
      <div class="chat-sharing-mobile__disclosure-content">{props.children}</div>
    </div>
  );
}

export function ChatSessionSharingMobile(props: ChatSessionSharingMobileProps) {
  return (
    <div class="chat-sharing-mobile">
      <section>
        <h3 class="chat-sharing-mobile__heading">{props.labels.sessionAccess}</h3>
        <button
          type="button"
          class="chat-sharing-mobile__mode chat-sharing-mobile__group"
          disabled={Boolean(props.accessDisabledReason)}
          aria-description={props.accessDisabledReason}
          onClick={() => {
            if (!props.accessDisabledReason) {
              props.onOpenAccess();
            }
          }}
        >
          <span class="chat-sharing-mobile__mode-icon" aria-hidden="true">
            {props.modes[props.visibility].icon()}
          </span>
          <span class="chat-sharing-mobile__mode-copy">
            <span>{sharingVisibilityLabel(props.visibility)}</span>
            <small>{props.modes[props.visibility].description}</small>
          </span>
          <Icon name="chevronRight" class="chat-sharing-mobile__trailing-icon" />
        </button>
      </section>
      <Show when={props.publicLink}>
        {(link) => (
          <section>
            <h3 class="chat-sharing-mobile__heading">{props.labels.linkSharing}</h3>
            <div
              class="chat-sharing-mobile__group chat-sharing-mobile__public"
              aria-description={link().disabledReason}
            >
              <SettingsToggleRow
                icon={<Icon name="globe" class="chat-sharing-mobile__mode-icon" />}
                title={props.labels.anyoneWithLink}
                checked={link().enabled}
                disabled={Boolean(link().disabledReason)}
                onChange={(enabled) => {
                  link().onChange(enabled);
                  // Keep the native input at the confirmed value while its owner asks for consent.
                  return false;
                }}
              />
              <SharingDisclosure open={link().enabled}>
                <p class="chat-sharing-mobile__public-description">{link().description}</p>
                <Show when={link().url}>
                  <button
                    type="button"
                    class="chat-sharing-mobile__copy"
                    aria-label={t("chat.sessionSharing.copyPublicLink")}
                    aria-description={link().copyDisabledReason ?? link().url}
                    disabled={Boolean(link().copyDisabledReason)}
                    onClick={() => {
                      if (!link().copyDisabledReason) {
                        link().onCopy();
                      }
                    }}
                  >
                    <span class="chat-sharing-mobile__url">{link().url}</span>
                    <Icon name="copy" />
                  </button>
                </Show>
              </SharingDisclosure>
            </div>
          </section>
        )}
      </Show>
      <Show when={props.error}>
        <p class="chat-sharing-mobile__error" role="alert">
          {props.error}
        </p>
      </Show>
      <Show when={props.permissions}>
        {(permissions) => <SharingPermissions data={permissions()} labels={props.labels} />}
      </Show>
    </div>
  );
}

function SharingPermissions(props: {
  data: NonNullable<ChatSessionSharingMobileProps["permissions"]>;
  labels: ChatSessionSharingMobileLabels;
}) {
  const searchId = createUniqueId();
  const [searching, setSearching] = createSignal(false);
  const [query, setQuery] = createSignal("");
  let input: HTMLInputElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  const matches = () => {
    const terms = query().trim().toLocaleLowerCase().split(/\s+/u);
    return props.data.rows.filter(({ identity }) =>
      terms.every((term) =>
        [identity.label, identity.id].join(" ").toLocaleLowerCase().includes(term),
      ),
    );
  };
  const closeSearch = () => {
    setSearching(false);
    setQuery("");
    trigger?.focus({ preventScroll: true });
  };
  return (
    <section>
      <div class="chat-sharing-mobile__permissions-heading">
        <h3 class="chat-sharing-mobile__heading">{props.labels.messagePermissions}</h3>
        <button
          ref={(element) => {
            trigger = element;
          }}
          type="button"
          class="chat-sharing-mobile__search-toggle"
          aria-label={searching() ? props.labels.hideSearch : props.labels.showSearch}
          aria-expanded={searching() ? "true" : "false"}
          aria-controls={searchId}
          onClick={() => {
            if (searching()) {
              closeSearch();
            } else {
              setSearching(true);
              onSettled(() => {
                input?.focus({ preventScroll: true });
              });
            }
          }}
        >
          <Icon name={searching() ? "x" : "search"} />
        </button>
      </div>
      <SharingDisclosure open={searching()}>
        <div class="chat-sharing-mobile__search">
          <Icon name="search" />
          <input
            ref={(element) => {
              input = element;
            }}
            id={searchId}
            type="search"
            autocomplete="off"
            aria-label={t("sessionsView.searchPeople")}
            placeholder={t("sessionsView.searchPeople")}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeSearch();
              }
            }}
          />
        </div>
      </SharingDisclosure>
      <div class="chat-sharing-mobile__group" aria-busy={props.data.loading ? "true" : "false"}>
        <Show
          when={!props.data.loading || props.data.rows.length > 0}
          fallback={
            <p class="chat-sharing-mobile__status" role="status">
              {t("common.loading")}
            </p>
          }
        >
          <For each={matches()} keyed={(row) => row.identity.id}>
            {(row) => <SharingPermissionRow row={row()} data={props.data} />}
          </For>
          <Show when={matches().length === 0}>
            <p class="chat-sharing-mobile__status" role="status">
              {t(query().trim() ? "sessionsView.noPeopleMatch" : "chat.sessionSharing.noPeople")}
            </p>
          </Show>
        </Show>
      </div>
    </section>
  );
}

function SharingPermissionRow(props: {
  row: ChatSessionSharingPermissionRow;
  data: NonNullable<ChatSessionSharingMobileProps["permissions"]>;
}) {
  const unavailable = () =>
    props.row.fixed || props.data.loading || Boolean(props.row.disabledReason);
  const name = () => props.row.identity.label ?? props.row.identity.id;
  const activity = () =>
    personActivityLink(
      props.row.identity.identity?.type === "profile" ? props.row.identity.identity.id : undefined,
      props.data.personActivity,
      name(),
    );
  return (
    <div
      class={[
        "chat-sharing-mobile__person",
        { "chat-sharing-mobile__person--fixed": props.row.fixed },
      ]}
    >
      <span class="chat-sharing-mobile__avatar">
        <PersonAvatarLink link={activity()}>
          <SessionOwnerAvatar owner={props.row.identity} />
        </PersonAvatarLink>
      </span>
      <PersonName label={name()} link={activity()} class="chat-sharing-mobile__person-name" />
      <button
        type="button"
        class="chat-sharing-mobile__permission"
        role="checkbox"
        aria-checked={props.row.selected ? "true" : "false"}
        aria-label={`${name()}, ${props.row.permissionLabel}`}
        aria-disabled={unavailable() ? "true" : undefined}
        aria-description={
          props.row.disabledReason ?? (props.data.loading ? t("common.loading") : undefined)
        }
        // Transient unavailability must not blur the focused membership control.
        disabled={props.row.fixed}
        onClick={() => {
          if (!unavailable()) {
            props.data.onMemberChange(props.row.identity.id, !props.row.selected);
          }
        }}
      >
        <span>{props.row.permissionLabel}</span>
        <span class="chat-sharing-mobile__check" aria-hidden="true">
          <Show when={props.row.selected}>
            <Icon name="check" />
          </Show>
        </span>
      </button>
    </div>
  );
}

export function ChatSessionAccessMobile(props: ChatSessionAccessMobileProps) {
  const selectVisibility = async (visibility: SessionVisibility) => {
    if (
      props.pending ||
      props.disabledReason ||
      !props.allowedVisibilities.includes(visibility) ||
      props.visibility === visibility
    ) {
      return;
    }
    if (await props.onVisibilityChange(visibility)) {
      props.onApplied();
    }
  };
  return (
    <div class="chat-sharing-mobile">
      <div
        class="chat-sharing-mobile__group"
        role="group"
        aria-label={props.label}
        aria-busy={props.pending ? "true" : "false"}
      >
        <For each={SESSION_VISIBILITY_VALUES}>
          {(visibility) => (
            <button
              type="button"
              class="chat-sharing-mobile__mode"
              aria-pressed={props.visibility === visibility ? "true" : "false"}
              disabled={
                props.pending ||
                Boolean(props.disabledReason) ||
                !props.allowedVisibilities.includes(visibility)
              }
              aria-description={props.disabledReason}
              onClick={() => {
                void selectVisibility(visibility);
              }}
            >
              <span class="chat-sharing-mobile__mode-icon" aria-hidden="true">
                {props.modes[visibility].icon()}
              </span>
              <span class="chat-sharing-mobile__mode-copy">
                <span>{sharingVisibilityLabel(visibility)}</span>
                <small>{props.modes[visibility].description}</small>
              </span>
              <span class="chat-sharing-mobile__check" aria-hidden="true">
                <Show when={props.visibility === visibility}>
                  <Icon name="check" />
                </Show>
              </span>
            </button>
          )}
        </For>
      </div>
      <Show when={props.error}>
        <p class="chat-sharing-mobile__error" role="alert">
          {props.error}
        </p>
      </Show>
    </div>
  );
}
