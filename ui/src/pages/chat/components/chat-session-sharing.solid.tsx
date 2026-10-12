import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { SESSION_VISIBILITY_VALUES } from "../../../../../packages/gateway-protocol/src/schema/sessions-sharing-constants.js";
import type {
  GatewaySessionRow,
  SessionMembersListEvidenceResult,
  SessionVisibility,
} from "../../../api/types.ts";
import {
  personActivityLink,
  renderPersonAvatarLink,
  renderPersonName,
  renderStandalonePersonLink,
  type PersonActivityRouting,
} from "../../../components/person-activity-link.ts";
import { handlePeopleMenuKeydown } from "../../../components/searchable-people-menu.ts";
import { renderSessionOwnerChip } from "../../../components/session-owner-chip.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { syncDropdownItemRadio } from "../../../components/web-awesome.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { LitContent } from "../../../lit/solid-content.tsx";

export type ChatSessionSharingState = {
  loading: boolean;
  result?: SessionMembersListEvidenceResult;
  error?: string;
};

export type ChatSessionSharingProps = {
  session: GatewaySessionRow | undefined;
  state: ChatSessionSharingState | undefined;
  allowedVisibilities?: readonly SessionVisibility[];
  membersAvailable?: boolean;
  openDisabledReason?: string;
  visibilityDisabledReason?: string;
  memberAddDisabledReason?: string;
  memberRemoveDisabledReason?: string;
  publicShareDisabledReason?: string;
  onPublicShareChange?: (enabled: boolean) => void;
  onCopyPublicLink?: () => void;
  ownerViewing?: boolean;
  personActivity?: PersonActivityRouting;
  showOwner?: boolean;
  onOpen: () => void;
  onVisibilityChange: (visibility: SessionVisibility) => void;
  onMemberChange: (identityId: string, member: boolean) => void;
};

const VISIBILITY_LABEL_KEYS: Record<SessionVisibility, string> = {
  shared: "chat.sessionSharing.shared",
  "read-only": "chat.sessionSharing.readOnly",
  suggest: "chat.sessionSharing.suggest",
  draft: "chat.sessionSharing.draft",
};

export function selectChatSessionSharingItem(
  props: ChatSessionSharingProps,
  value: string | undefined,
): void {
  if (value?.startsWith("public:")) {
    if (
      !props.session ||
      !canManageChatSessionSharing(props.session) ||
      props.state?.loading ||
      !props.state?.result
    ) {
      return;
    }
    if (value === "public:copy" && props.state.result.publicShare) {
      props.onCopyPublicLink?.();
    } else if (
      !props.publicShareDisabledReason &&
      (value === "public:enable" || value === "public:disable")
    ) {
      props.onPublicShareChange?.(value === "public:enable");
    }
    return;
  }
  const members = new Set(props.state?.result?.members.map((member) => member.identityId) ?? []);
  if (value?.startsWith("visibility:")) {
    const visibility = SESSION_VISIBILITY_VALUES.find((option) => value === `visibility:${option}`);
    if (
      visibility &&
      !props.visibilityDisabledReason &&
      visibility !== (props.session?.visibility ?? "shared")
    ) {
      props.onVisibilityChange(visibility);
    }
    return;
  }
  if (!value?.startsWith("member:")) {
    return;
  }
  const identityId = value.slice("member:".length);
  const member = !members.has(identityId);
  const disabledReason = member ? props.memberAddDisabledReason : props.memberRemoveDisabledReason;
  if (!disabledReason) {
    props.onMemberChange(identityId, member);
  }
}

export function canManageChatSessionSharing(
  session: Pick<GatewaySessionRow, "sharingRole">,
): boolean {
  return session.sharingRole === "admin" || session.sharingRole === "owner";
}

function SharingIcon(props: { visibility: SessionVisibility }) {
  return (
    <Icon
      name={
        props.visibility === "draft" ? "pencil" : props.visibility === "shared" ? "users" : "lock"
      }
    />
  );
}

export function ChatSessionPublicIndicator(props: ChatSessionSharingProps) {
  return (
    <Show when={props.state?.result?.publicShare}>
      <span
        class="chat-pane__public-share-indicator"
        role="status"
        aria-label={t("chat.sessionSharing.worldReadable")}
        title={t("chat.sessionSharing.worldReadable")}
      >
        <span aria-hidden="true">
          <Icon name="globe" />
        </span>
        <span>{t("chat.sessionSharing.publicIndicator")}</span>
      </span>
    </Show>
  );
}

function SharingContent(props: ChatSessionSharingProps) {
  const result = () => props.state?.result;
  const visibility = () => props.session?.visibility ?? "shared";
  const owner = () => result()?.owner ?? props.session?.owner?.actor;
  const ownerActivity = () =>
    personActivityLink(
      owner()?.identity?.type === "profile" ? owner()?.identity?.id : undefined,
      props.personActivity,
      owner()?.label,
    );
  const members = createMemo(
    () => new Set(result()?.members.map((member) => member.identityId) ?? []),
  );
  const identities = () =>
    result()?.identities.filter((identity) => identity.id !== result()?.owner?.id) ?? [];
  const allowed = () =>
    result()?.allowedVisibilities ?? props.allowedVisibilities ?? [visibility()];
  const canPublish = () => visibility() === "draft" && allowed().includes("shared");
  const scope = createMemo(result);
  const [query, setQuery] = createSignal(() => {
    scope();
    return "";
  });
  const matches = () => {
    const terms = query().trim().toLocaleLowerCase().split(/\s+/u);
    return identities().filter((identity) =>
      terms.every((term) =>
        [identity.label, identity.id, identity.type].join(" ").toLocaleLowerCase().includes(term),
      ),
    );
  };
  return (
    <>
      <Show when={canPublish()}>
        <wa-dropdown-item
          value="visibility:shared"
          class="session-menu__item chat-pane__publish-draft"
          disabled={Boolean(props.visibilityDisabledReason)}
          title={props.visibilityDisabledReason}
        >
          <span class="session-menu__text">{t("chat.sessionSharing.publishDraft")}</span>
          <span slot="details" aria-hidden="true">
            <Icon name="users" />
          </span>
        </wa-dropdown-item>
        <div class="session-menu__separator" role="separator" />
      </Show>
      <div class="chat-pane__sharing-title chat-pane__sharing-visibility-title">
        {t("chat.sessionSharing.visibility")}
      </div>
      <For each={allowed().filter((option) => !canPublish() || option !== "shared")}>
        {(option) => {
          const checked = () => option === visibility();
          let item: HTMLElement | undefined;
          createEffect(checked, (value) => syncDropdownItemRadio(item, value));
          return (
            <wa-dropdown-item
              class="session-menu__item chat-pane__sharing-visibility-item"
              value={`visibility:${option}`}
              role="menuitemradio"
              aria-checked={checked() ? "true" : "false"}
              ref={(element) => {
                item = element;
              }}
              disabled={Boolean(props.visibilityDisabledReason)}
              title={props.visibilityDisabledReason}
            >
              <span slot="icon" class="session-menu__icon" aria-hidden="true">
                <SharingIcon visibility={option} />
              </span>
              <span class="session-menu__text">{t(VISIBILITY_LABEL_KEYS[option])}</span>
              <Show when={checked()}>
                <span slot="details" class="session-menu__check" aria-hidden="true">
                  <Icon name="check" />
                </span>
              </Show>
            </wa-dropdown-item>
          );
        }}
      </For>
      <Show when={props.onPublicShareChange}>
        <div class="session-menu__separator" role="separator" />
        <div class="chat-pane__sharing-title">{t("chat.sessionSharing.publicAccess")}</div>
        <div class="chat-pane__sharing-status">
          {t(
            props.state?.loading || !result()
              ? "common.loading"
              : result()?.publicShare
                ? "chat.sessionSharing.worldReadable"
                : "chat.sessionSharing.notPublic",
          )}
        </div>
        <Show when={result()?.publicShare}>
          <wa-dropdown-item
            class="session-menu__item"
            value="public:copy"
            disabled={Boolean(props.state?.loading)}
          >
            {t("chat.sessionSharing.copyPublicLink")}
          </wa-dropdown-item>
        </Show>
        <wa-dropdown-item
          class="session-menu__item"
          value={result()?.publicShare ? "public:disable" : "public:enable"}
          disabled={Boolean(props.publicShareDisabledReason || props.state?.loading || !result())}
          title={props.publicShareDisabledReason}
        >
          {t(
            result()?.publicShare
              ? "chat.sessionSharing.disablePublicAccess"
              : "chat.sessionSharing.enablePublicAccess",
          )}
        </wa-dropdown-item>
      </Show>
      <Show when={owner()}>
        {(person) => (
          <>
            <div class="chat-pane__sharing-title chat-pane__sharing-owner-title">
              {t("chat.sessionSharing.owner")}
            </div>
            <div class="chat-pane__sharing-owner">
              <span class="chat-pane__sharing-member-icon" aria-hidden="true">
                <Show when={person().type === "human"} fallback={<Icon name="bot" />}>
                  <LitContent
                    value={renderPersonAvatarLink(
                      renderSessionOwnerChip(person(), "header", "owned", props.ownerViewing),
                      ownerActivity(),
                    )}
                  />
                </Show>
              </span>
              <LitContent
                value={renderPersonName(
                  person().label ?? person().id ?? t("chat.sessionSharing.owner"),
                  ownerActivity(),
                  "session-menu__text",
                )}
              />
            </div>
          </>
        )}
      </Show>
      <Show when={props.membersAvailable !== false}>
        <div class="chat-pane__sharing-title chat-pane__sharing-members-title">
          {t("chat.sessionSharing.members")}
        </div>
        <Show
          when={!props.state?.loading}
          fallback={
            <div
              class="chat-pane__sharing-members-loading"
              role="status"
              aria-busy="true"
              aria-label={t("common.loading")}
            >
              <For each={[0, 1, 2]}>
                {() => (
                  <div class="chat-pane__sharing-member-skeleton" aria-hidden="true">
                    <span class="skeleton chat-pane__sharing-member-skeleton-icon" />
                    <span class="skeleton chat-pane__sharing-member-skeleton-label" />
                  </div>
                )}
              </For>
            </div>
          }
        >
          <Show
            when={identities().length > 0}
            fallback={
              <div class="chat-pane__sharing-status">{t("chat.sessionSharing.noPeople")}</div>
            }
          >
            <div class="people-menu__search" onClick={(event) => event.stopPropagation()}>
              <input
                type="search"
                autocomplete="off"
                aria-label={t("sessionsView.searchPeople")}
                placeholder={t("sessionsView.searchPeople")}
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (handlePeopleMenuKeydown(event) || event.key === "Escape") {
                    return;
                  }
                  event.stopPropagation();
                  if (
                    event.isComposing ||
                    event.keyCode === 229 ||
                    !["ArrowDown", "Enter"].includes(event.key)
                  ) {
                    return;
                  }
                  event.preventDefault();
                  let item = event.currentTarget.parentElement?.nextElementSibling;
                  while (item?.localName === "wa-dropdown-item") {
                    if (item instanceof HTMLElement && !item.hasAttribute("disabled")) {
                      item.focus();
                      return;
                    }
                    item = item.nextElementSibling;
                  }
                }}
              />
            </div>
            <For each={matches()} keyed={(identity) => identity.id}>
              {(identity) => {
                const disabledReason = () =>
                  members().has(identity().id)
                    ? props.memberRemoveDisabledReason
                    : props.memberAddDisabledReason;
                return (
                  <wa-dropdown-item
                    class="session-menu__item chat-pane__sharing-member"
                    value={`member:${identity().id}`}
                    disabled={Boolean(disabledReason())}
                    title={disabledReason()}
                  >
                    <span slot="icon" class="chat-pane__sharing-member-icon" aria-hidden="true">
                      <Show when={identity().type === "human"} fallback={<Icon name="bot" />}>
                        <LitContent value={renderSessionOwnerChip(identity(), "header")} />
                      </Show>
                    </span>
                    <span
                      class="session-menu__text chat-pane__sharing-member-label"
                      title={disabledReason() ? undefined : (identity().label ?? identity().id)}
                    >
                      {identity().label ?? identity().id}
                    </span>
                    <Show when={members().has(identity().id)}>
                      <span
                        slot="details"
                        class="session-menu__check"
                        aria-label={t("chat.sessionSharing.selected")}
                      >
                        <Icon name="check" />
                      </span>
                    </Show>
                  </wa-dropdown-item>
                );
              }}
            </For>
            <Show when={matches().length === 0}>
              <div class="people-menu__status" role="status">
                {t("sessionsView.noPeopleMatch")}
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
      <Show when={props.state?.error}>
        <div class="chat-pane__sharing-status chat-pane__sharing-status--error" role="alert">
          {props.state?.error}
        </div>
      </Show>
    </>
  );
}

export function ChatSessionSharing(props: ChatSessionSharingProps & { inline?: boolean }) {
  const visibility = () => props.session?.visibility ?? "shared";
  const owner = () => props.state?.result?.owner ?? props.session?.owner?.actor;
  const canManage = () => props.session && canManageChatSessionSharing(props.session);
  const capped = () => {
    const result = props.state?.result;
    const allowed = result?.allowedVisibilities ?? props.allowedVisibilities ?? [visibility()];
    return (
      props.membersAvailable !== false &&
      allowed.length +
        (result?.identities.filter((identity) => identity.id !== result.owner?.id).length ?? 0) +
        (owner() ? 1 : 0) >
        12
    );
  };
  return (
    <Show when={props.session}>
      <Show
        when={canManage()}
        fallback={
          <Show when={visibility() === "draft"}>
            <Show when={props.showOwner && owner()}>
              {(person) => (
                <LitContent
                  value={renderStandalonePersonLink(
                    renderSessionOwnerChip(person(), "header", "owned", props.ownerViewing),
                    personActivityLink(
                      person().identity?.type === "profile" ? person().identity?.id : undefined,
                      props.personActivity,
                      person().label,
                    ),
                  )}
                />
              )}
            </Show>
            <span class="chat-pane__draft-indicator" title={t("chat.sessionSharing.draft")}>
              <SharingIcon visibility="draft" />
            </span>
          </Show>
        }
      >
        <Show when={!props.inline} fallback={<SharingContent {...props} />}>
          <ChatSessionPublicIndicator {...props} />
          <wa-dropdown
            class={["chat-pane__sharing-menu", { "chat-pane__sharing-menu--capped": capped() }]}
            placement="bottom-end"
            onKeyDown={handlePeopleMenuKeydown}
            onWa-show={() => {
              if (!props.openDisabledReason) {
                props.onOpen();
              }
            }}
            onWa-select={(event: CustomEvent<{ item: { value?: string } }>) =>
              selectChatSessionSharingItem(props, event.detail.item.value)
            }
          >
            <button
              slot="trigger"
              class="btn btn--ghost btn--icon chat-icon-btn chat-pane__sharing-trigger"
              type="button"
              aria-label={t("chat.sessionSharing.menu")}
              disabled={Boolean(props.openDisabledReason)}
              title={
                props.openDisabledReason ??
                t("chat.sessionSharing.current", {
                  visibility: t(VISIBILITY_LABEL_KEYS[visibility()]),
                })
              }
            >
              <SharingIcon visibility={visibility()} />
            </button>
            <SharingContent {...props} />
          </wa-dropdown>
        </Show>
      </Show>
    </Show>
  );
}
