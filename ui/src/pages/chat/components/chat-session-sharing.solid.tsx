import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { SESSION_VISIBILITY_VALUES } from "../../../../../packages/gateway-protocol/src/schema/sessions-sharing-constants.js";
import type {
  GatewaySessionRow,
  SessionMembersListEvidenceResult,
  SessionVisibility,
} from "../../../api/types.ts";
import {
  PersonAvatarLink,
  PersonName,
  StandalonePersonLink,
} from "../../../components/person-activity-link-solid.tsx";
import {
  personActivityLink,
  type PersonActivityRouting,
} from "../../../components/person-activity-link.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuEntry } from "../../../components/solid/menu.tsx";
import { renderSessionOwnerChip } from "../../../components/solid/session-presentation.tsx";
import { registerSessionPeopleEnglish } from "../../../i18n/locales/en-session-people.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerSessionPeopleEnglish);

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

export function useChatSessionSharingMenu(props: ChatSessionSharingProps): {
  items: () => readonly MenuEntry[];
} {
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
  const search = (
    <div class="people-menu__search" onClick={(event) => event.stopPropagation()}>
      <input
        type="search"
        data-search=""
        data-form-control=""
        autocomplete="off"
        aria-label={t("sessionsView.searchPeople")}
        placeholder={t("sessionsView.searchPeople")}
        value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
    </div>
  );
  const searchEntry: MenuEntry = { kind: "content", id: "members-search", content: search };
  const baseItems = createMemo((): readonly MenuEntry[] => {
    const entries: MenuEntry[] = [];
    if (canPublish()) {
      entries.push(
        {
          id: "visibility:shared",
          label: t("chat.sessionSharing.publishDraft"),
          class: "session-menu__item chat-pane__publish-draft",
          disabled: Boolean(props.visibilityDisabledReason),
          attributes: { title: props.visibilityDisabledReason },
          content: <span class="session-menu__text">{t("chat.sessionSharing.publishDraft")}</span>,
          details: (
            <span aria-hidden="true">
              <Icon name="users" />
            </span>
          ),
        },
        {
          kind: "content",
          id: "publish-separator",
          content: <div class="session-menu__separator" role="separator" />,
        },
      );
    }
    entries.push({
      kind: "content",
      id: "visibility-title",
      content: (
        <div class="chat-pane__sharing-title chat-pane__sharing-visibility-title">
          {t("chat.sessionSharing.visibility")}
        </div>
      ),
    });
    for (const option of allowed().filter((candidate) => !canPublish() || candidate !== "shared")) {
      const checked = option === visibility();
      entries.push({
        id: `visibility:${option}`,
        label: t(VISIBILITY_LABEL_KEYS[option]),
        class: "session-menu__item chat-pane__sharing-visibility-item",
        type: "radio",
        checked,
        disabled: Boolean(props.visibilityDisabledReason),
        attributes: { title: props.visibilityDisabledReason },
        icon: (
          <span class="session-menu__icon" aria-hidden="true">
            <SharingIcon visibility={option} />
          </span>
        ),
        content: <span class="session-menu__text">{t(VISIBILITY_LABEL_KEYS[option])}</span>,
        details: checked ? (
          <span class="session-menu__check" aria-hidden="true">
            <Icon name="check" />
          </span>
        ) : undefined,
      });
    }
    if (props.onPublicShareChange) {
      entries.push({
        kind: "content",
        id: "public-title",
        content: (
          <>
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
          </>
        ),
      });
      if (result()?.publicShare) {
        entries.push({
          id: "public:copy",
          label: t("chat.sessionSharing.copyPublicLink"),
          class: "session-menu__item",
          disabled: Boolean(props.state?.loading),
        });
      }
      entries.push({
        id: result()?.publicShare ? "public:disable" : "public:enable",
        label: t(
          result()?.publicShare
            ? "chat.sessionSharing.disablePublicAccess"
            : "chat.sessionSharing.enablePublicAccess",
        ),
        class: "session-menu__item",
        disabled: Boolean(props.publicShareDisabledReason || props.state?.loading || !result()),
        attributes: { title: props.publicShareDisabledReason },
      });
    }
    if (owner()) {
      entries.push({
        kind: "content",
        id: "owner",
        content: (
          <Show when={owner()}>
            {(person) => (
              <>
                <div class="chat-pane__sharing-title chat-pane__sharing-owner-title">
                  {t("chat.sessionSharing.owner")}
                </div>
                <div class="chat-pane__sharing-owner">
                  <span class="chat-pane__sharing-member-icon" aria-hidden="true">
                    <Show when={person().type === "human"} fallback={<Icon name="bot" />}>
                      <PersonAvatarLink link={ownerActivity()}>
                        {renderSessionOwnerChip(person(), "header", "owned", props.ownerViewing)}
                      </PersonAvatarLink>
                    </Show>
                  </span>
                  <PersonName
                    label={person().label ?? person().id ?? t("chat.sessionSharing.owner")}
                    link={ownerActivity()}
                    class="session-menu__text"
                  />
                </div>
              </>
            )}
          </Show>
        ),
      });
    }
    if (props.membersAvailable !== false) {
      entries.push({
        kind: "content",
        id: "members-title",
        content: (
          <div class="chat-pane__sharing-title chat-pane__sharing-members-title">
            {t("chat.sessionSharing.members")}
          </div>
        ),
      });
      if (props.state?.loading) {
        entries.push({
          kind: "content",
          id: "members-loading",
          content: (
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
          ),
        });
      } else if (identities().length === 0) {
        entries.push({
          kind: "content",
          id: "members-empty",
          content: <div class="chat-pane__sharing-status">{t("chat.sessionSharing.noPeople")}</div>,
        });
      } else {
        entries.push(searchEntry);
      }
    }
    return entries;
  });
  const memberItems = createMemo((): readonly MenuEntry[] => {
    if (props.membersAvailable === false || props.state?.loading || identities().length === 0) {
      return [];
    }
    const entries: MenuEntry[] = [];
    for (const identity of matches()) {
      const member = members().has(identity.id);
      const disabledReason = member
        ? props.memberRemoveDisabledReason
        : props.memberAddDisabledReason;
      entries.push({
        id: `member:${identity.id}`,
        label: identity.label ?? identity.id,
        class: "session-menu__item chat-pane__sharing-member",
        disabled: Boolean(disabledReason),
        attributes: { title: disabledReason },
        icon: (
          <span class="chat-pane__sharing-member-icon" aria-hidden="true">
            <Show when={identity.type === "human"} fallback={<Icon name="bot" />}>
              {renderSessionOwnerChip(identity, "header")}
            </Show>
          </span>
        ),
        content: (
          <span
            class="session-menu__text chat-pane__sharing-member-label"
            title={disabledReason ? undefined : (identity.label ?? identity.id)}
          >
            {identity.label ?? identity.id}
          </span>
        ),
        details: member ? (
          <span class="session-menu__check" aria-label={t("chat.sessionSharing.selected")}>
            <Icon name="check" />
          </span>
        ) : undefined,
      });
    }
    if (matches().length === 0) {
      entries.push({
        kind: "content",
        id: "members-no-match",
        content: (
          <div class="people-menu__status" role="status">
            {t("sessionsView.noPeopleMatch")}
          </div>
        ),
      });
    }
    return entries;
  });
  const errorEntry: MenuEntry = {
    kind: "content",
    id: "error",
    content: (
      <div class="chat-pane__sharing-status chat-pane__sharing-status--error" role="alert">
        {props.state?.error}
      </div>
    ),
  };
  const items = createMemo(() => [
    ...baseItems(),
    ...memberItems(),
    ...(props.state?.error ? [errorEntry] : []),
  ]);
  return { items };
}

export function ChatSessionSharing(props: ChatSessionSharingProps) {
  const id = createUniqueId();
  const sharing = useChatSessionSharingMenu(props);
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
                <StandalonePersonLink
                  link={personActivityLink(
                    person().identity?.type === "profile" ? person().identity?.id : undefined,
                    props.personActivity,
                    person().label,
                  )}
                >
                  {renderSessionOwnerChip(person(), "header", "owned", props.ownerViewing)}
                </StandalonePersonLink>
              )}
            </Show>
            <span class="chat-pane__draft-indicator" title={t("chat.sessionSharing.draft")}>
              <SharingIcon visibility="draft" />
            </span>
          </Show>
        }
      >
        <ChatSessionPublicIndicator {...props} />
        <Menu
          lazy
          id={id}
          class={
            capped()
              ? "chat-pane__sharing-menu chat-pane__sharing-menu--capped"
              : "chat-pane__sharing-menu"
          }
          panelClass="session-menu chat-pane__sharing-panel"
          label={t("chat.sessionSharing.menu")}
          placement="bottom-end"
          disabled={Boolean(props.openDisabledReason)}
          triggerClass="btn btn--ghost chat-pane__sharing-trigger"
          triggerAttributes={{
            title:
              props.openDisabledReason ??
              t("chat.sessionSharing.current", {
                visibility: t(VISIBILITY_LABEL_KEYS[visibility()]),
              }),
          }}
          trigger={
            <>
              <SharingIcon visibility={visibility()} />
              <span>{t("chat.sessionSharing.share")}</span>
            </>
          }
          items={sharing.items()}
          onBeforeShow={() => {
            if (!props.openDisabledReason) {
              props.onOpen();
            }
          }}
          onSelect={(item) => selectChatSessionSharingItem(props, item.id)}
        />
      </Show>
    </Show>
  );
}
