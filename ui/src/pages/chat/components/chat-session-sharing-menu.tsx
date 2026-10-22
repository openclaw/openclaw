import {
  createMemo,
  createSignal,
  For,
  isPending,
  latest,
  Loading,
  mapArray,
  Show,
} from "solid-js";
import { PersonAvatarLink, PersonName } from "../../../components/person-activity-link-solid.tsx";
import { personActivityLink } from "../../../components/person-activity-link.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuControls, MenuEntry } from "../../../components/solid/menu.tsx";
import { SessionOwnerChip } from "../../../components/solid/session-owner-chip.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  type ChatSessionSharingProps,
  type ChatSessionSharingOutcome,
  VISIBILITY_LABEL_KEYS,
  ChatSessionSharingModeIcon,
  ChatSessionSharingError,
  createChatSessionSharingPresentation,
} from "./chat-session-sharing-shared.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

export function useChatSessionSharingMenu(
  props: ChatSessionSharingProps,
  controls?: MenuControls,
): {
  items: () => readonly MenuEntry[];
  select: (value: string) => Promise<void | ChatSessionSharingOutcome>;
} {
  const presentation = createChatSessionSharingPresentation(() => props);
  const busy = () => presentation.busy() || props.state?.loading === true;
  const readMembers = () => {
    latest(presentation.read);
    return null;
  };
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
  const scope = presentation.scope;
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
  const searchEntry = createMemo(
    (): MenuEntry => ({
      kind: "content",
      id: "members-search",
      content: (
        <div class="people-menu__search" onClick={(event) => event.stopPropagation()}>
          <input
            ref={controls?.ref()}
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
      ),
    }),
    { lazy: true },
  );
  const baseItems = createMemo(
    (): readonly MenuEntry[] => {
      const entries: MenuEntry[] = [];
      if (canPublish()) {
        entries.push(
          {
            id: "visibility:shared",
            label: t("chat.sessionSharing.publishDraft"),
            class: "session-menu__item chat-pane__publish-draft",
            disabled: Boolean(busy() || props.visibilityDisabledReason),
            attributes: { title: props.visibilityDisabledReason },
            content: (
              <span class="session-menu__text">{t("chat.sessionSharing.publishDraft")}</span>
            ),
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
      for (const option of allowed().filter(
        (candidate) => !canPublish() || candidate !== "shared",
      )) {
        const checked = option === visibility();
        entries.push({
          id: `visibility:${option}`,
          label: t(VISIBILITY_LABEL_KEYS[option]),
          class: "session-menu__item chat-pane__sharing-visibility-item",
          type: "radio",
          checked,
          disabled: Boolean(busy() || props.visibilityDisabledReason),
          attributes: { title: props.visibilityDisabledReason },
          icon: (
            <span class="session-menu__icon" aria-hidden="true">
              <ChatSessionSharingModeIcon visibility={option} />
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
                  busy() || !result()
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
            closeOnSelect: false,
            disabled: busy(),
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
          disabled: Boolean(props.publicShareDisabledReason || busy() || !result()),
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
                          <SessionOwnerChip
                            owner={person()}
                            size="header"
                            attribution="owned"
                            viewingNow={props.ownerViewing}
                          />
                        </PersonAvatarLink>
                      </Show>
                    </span>
                    <PersonName
                      ref={controls?.ref()}
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
        if (identities().length > 0) {
          entries.push(searchEntry());
        }
      }
      return entries;
    },
    { lazy: true },
  );
  const memberItems = createMemo(
    () =>
      mapArray(
        () => (props.membersAvailable === false ? [] : matches()),
        (identity): MenuEntry => {
          const member = () => members().has(identity().id);
          const disabledReason = () =>
            member() ? props.memberRemoveDisabledReason : props.memberAddDisabledReason;
          return {
            get id() {
              return `member:${identity().id}`;
            },
            get label() {
              return identity().label ?? identity().id;
            },
            class: "session-menu__item chat-pane__sharing-member",
            get disabled() {
              return Boolean(busy() || disabledReason());
            },
            get attributes() {
              return { title: disabledReason() };
            },
            icon: (
              <span class="chat-pane__sharing-member-icon" aria-hidden="true">
                <Show when={identity().type === "human"} fallback={<Icon name="bot" />}>
                  <SessionOwnerChip owner={identity()} size="header" />
                </Show>
              </span>
            ),
            content: (
              <span
                class="session-menu__text chat-pane__sharing-member-label"
                title={disabledReason() ? undefined : (identity().label ?? identity().id)}
              >
                {identity().label ?? identity().id}
              </span>
            ),
            details: (
              <Show when={member()}>
                <span class="session-menu__check" aria-label={t("chat.sessionSharing.selected")}>
                  <Icon name="check" />
                </span>
              </Show>
            ),
          };
        },
        { keyed: (identity) => identity.id },
      ),
    { lazy: true },
  );
  const errorEntry = createMemo(
    (): MenuEntry => ({
      kind: "content",
      id: "error",
      content: (
        <ChatSessionSharingError
          error={props.state?.error}
          completion={presentation.completion()}
          pending={presentation.busy()}
        >
          {(error) => (
            <div class="chat-pane__sharing-status chat-pane__sharing-status--error" role="alert">
              {error}
            </div>
          )}
        </ChatSessionSharingError>
      ),
    }),
    { lazy: true },
  );
  const membersSection: MenuEntry = {
    kind: "group",
    id: "members",
    get items() {
      return memberItems()();
    },
    render: (renderItems) => (
      <Show when={props.membersAvailable !== false}>
        <Loading
          on={scope()}
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
          {readMembers()}
          <div aria-busy={isPending(presentation.read) || busy() ? "true" : "false"}>
            {renderItems(() => memberItems()())}
            <Show when={memberItems()().length === 0}>
              <div class="people-menu__status" role="status">
                {t(
                  identities().length
                    ? "sessionsView.noPeopleMatch"
                    : "chat.sessionSharing.noPeople",
                )}
              </div>
            </Show>
          </div>
        </Loading>
      </Show>
    ),
  };
  const items = createMemo(() => [...baseItems(), membersSection, errorEntry()], { lazy: true });
  return { items, select: presentation.select };
}
