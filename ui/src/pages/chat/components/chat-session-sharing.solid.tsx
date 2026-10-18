import type { JSX } from "@solidjs/web";
import {
  createMemo,
  createSignal,
  createUniqueId,
  flush,
  mapArray,
  onSettled,
  Show,
} from "solid-js";
import type { SessionVisibility } from "../../../api/types.ts";
import {
  PersonAvatarLink,
  PersonName,
  StandalonePersonLink,
} from "../../../components/person-activity-link-solid.tsx";
import { personActivityLink } from "../../../components/person-activity-link.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import {
  createMenuControls,
  Menu,
  type MenuControls,
  type MenuEntry,
  type MenuHandle,
} from "../../../components/solid/menu.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { SessionOwnerChip } from "../../../components/solid/session-owner-chip.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  type ChatSessionSharingProps,
  VISIBILITY_LABEL_KEYS,
  CHAT_SESSION_SHARING_DESCRIPTION_KEYS,
  selectChatSessionSharingItem,
  canManageChatSessionSharing,
  ChatSessionSharingModeIcon,
  projectChatSessionSharingRoster,
} from "./chat-session-sharing-shared.tsx";

export * from "./chat-session-sharing-shared.tsx";
export { useChatSessionSharingMenu } from "./chat-session-sharing-menu.tsx";

function SharingModeContent(props: { visibility: SessionVisibility }) {
  return (
    <>
      <span class="chat-pane__sharing-mode-icon">
        <Show
          when={props.visibility === "read-only"}
          fallback={<ChatSessionSharingModeIcon visibility={props.visibility} />}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
            <path d="M7 11h10M7 15h6M7 7h8" />
          </svg>
        </Show>
      </span>
      <span class="chat-pane__sharing-mode-text">
        <span>{t(VISIBILITY_LABEL_KEYS[props.visibility])}</span>
        <span class="chat-pane__sharing-description">
          {t(CHAT_SESSION_SHARING_DESCRIPTION_KEYS[props.visibility])}
        </span>
      </span>
    </>
  );
}

function useDesktopSharing(props: ChatSessionSharingProps, controls: MenuControls) {
  let menu: MenuHandle | undefined;
  let search: HTMLInputElement | undefined;
  let searchToggle: HTMLButtonElement | undefined;
  const scope = createMemo(() => `${props.session?.key}\0${props.session?.sessionId}`);
  const [query, setQuery] = createSignal(() => {
    scope();
    return "";
  });
  const [searchOpen, setSearchOpen] = createSignal(() => {
    scope();
    return false;
  });
  const [copied, setCopied] = createSignal(() => {
    scope();
    return false;
  });
  const [copyError, setCopyError] = createSignal(() => {
    scope();
    return "";
  });
  const [immediate, setImmediate] = createSignal(false);
  const [accessOpen, setAccessOpen] = createSignal(() => {
    scope();
    return false;
  });
  const navigateAccess = (open: boolean) => {
    setAccessOpen(open);
    onSettled(() => {
      if (!menu?.overlay.open) {
        return;
      }
      menu.itemElement(accessOpen() ? "access:back" : "access")?.focus({ preventScroll: true });
    });
  };
  const visibility = () => props.session?.visibility ?? "shared";
  const result = () => props.state?.result;
  const creator = () => result()?.owner;
  const members = createMemo(() => new Set(result()?.members.map((member) => member.identityId)));
  const people = createMemo(() =>
    projectChatSessionSharingRoster(props).map((row) => row.identity),
  );
  const matches = createMemo(() => {
    const terms = query().trim().toLocaleLowerCase().split(/\s+/u);
    return people().filter((person) =>
      terms.every((term) =>
        `${person.label ?? ""} ${person.id} ${person.type}`.toLocaleLowerCase().includes(term),
      ),
    );
  });
  const resetSearch = (focus = false) => {
    setQuery("");
    setSearchOpen(false);
    if (focus) {
      searchToggle?.focus({ preventScroll: true });
    }
  };
  const select = async (value: string) => {
    if (value === "access" || value === "access:back") {
      navigateAccess(value === "access");
      return;
    }
    if (value === `visibility:${visibility()}`) {
      navigateAccess(false);
      return;
    }
    const selectedScope = scope();
    if (value === "public:copy") {
      setCopied(false);
      setCopyError("");
    }
    const outcome = await selectChatSessionSharingItem(props, value);
    if (scope() !== selectedScope || !menu?.overlay.open || !outcome) {
      return;
    }
    if (value === "public:copy") {
      setCopied(outcome?.status === "success");
      setCopyError(outcome?.status === "failed" ? outcome.error : "");
    }
    if (outcome?.status === "success" && value.startsWith("visibility:")) {
      resetSearch();
      navigateAccess(false);
    }
  };
  const allowed = () =>
    result()?.allowedVisibilities ?? props.allowedVisibilities ?? [visibility()];
  const accessItems = createMemo(
    (): readonly MenuEntry[] =>
      (["shared", "read-only", "suggest", "draft"] as const).map((mode) => ({
        id: `visibility:${mode}`,
        get label() {
          return t(VISIBILITY_LABEL_KEYS[mode]);
        },
        class: "chat-pane__sharing-access-option",
        type: "radio",
        get checked() {
          return mode === visibility();
        },
        get disabled() {
          return (
            !allowed().includes(mode) ||
            Boolean(props.visibilityDisabledReason || props.state?.loading)
          );
        },
        get attributes() {
          return { title: props.visibilityDisabledReason };
        },
        closeOnSelect: false,
        content: <SharingModeContent visibility={mode} />,
        details: (
          <Show when={mode === visibility()}>
            <Icon name="check" />
          </Show>
        ),
      })),
    { lazy: true },
  );
  const rosterItems = createMemo(
    () =>
      mapArray(
        matches,
        (person) => {
          const isCreator = () => person().id === creator()?.id;
          const selected = () => isCreator() || members().has(person().id);
          const reason = () =>
            selected() ? props.memberRemoveDisabledReason : props.memberAddDisabledReason;
          const activity = () =>
            personActivityLink(
              creator()?.identity?.type === "profile" ? creator()?.identity?.id : undefined,
              props.personActivity,
              creator()?.label,
            );
          const Content = () => (
            <>
              <span class="chat-pane__sharing-member-icon">
                <Show when={person().type === "human"} fallback={<Icon name="bot" />}>
                  <Show
                    when={isCreator()}
                    fallback={<SessionOwnerChip owner={person()} size="header" />}
                  >
                    <PersonAvatarLink link={activity()}>
                      <SessionOwnerChip
                        owner={person()}
                        size="header"
                        attribution="owned"
                        viewingNow={props.ownerViewing}
                      />
                    </PersonAvatarLink>
                  </Show>
                </Show>
              </span>
              <Show
                when={isCreator()}
                fallback={
                  <span class="chat-pane__sharing-member-label">
                    {person().label ?? person().id}
                  </span>
                }
              >
                <PersonName
                  ref={controls.ref()}
                  label={person().label ?? person().id}
                  link={activity()}
                  class="chat-pane__sharing-member-label"
                />
              </Show>
              <span class="chat-pane__sharing-permission">
                {t(
                  isCreator()
                    ? "chat.sessionSharing.owner"
                    : "chat.sessionSharing.permissionUnavailable",
                )}
              </span>
              <span
                class="chat-pane__sharing-member-check"
                aria-label={selected() ? t("chat.sessionSharing.selected") : undefined}
              >
                <Show when={selected()}>
                  <Icon name="check" />
                </Show>
              </span>
            </>
          );
          return createMemo(
            (): MenuEntry =>
              isCreator()
                ? {
                    kind: "content",
                    id: `member:${person().id}`,
                    content: (
                      <div
                        class="chat-pane__sharing-person chat-pane__sharing-person--creator"
                        data-value={`member:${person().id}`}
                      >
                        <Content />
                      </div>
                    ),
                  }
                : {
                    get id() {
                      return `member:${person().id}`;
                    },
                    get label() {
                      return person().label ?? person().id;
                    },
                    type: "checkbox",
                    get checked() {
                      return selected();
                    },
                    get disabled() {
                      return Boolean(reason() || props.state?.loading);
                    },
                    closeOnSelect: false,
                    render: (attributes) => (
                      <button
                        {...attributes}
                        type="button"
                        class="chat-pane__sharing-person"
                        disabled={Boolean(reason() || props.state?.loading)}
                        title={
                          reason() ?? t("chat.sessionSharing.permissionUnavailableDescription")
                        }
                      >
                        <Content />
                      </button>
                    ),
                  },
            { lazy: true },
          );
        },
        { keyed: (person) => person.id },
      ),
    { lazy: true },
  );
  const showPermissions = () =>
    props.membersAvailable !== false &&
    (!result() || props.state?.loading || Boolean(props.state?.error) || people().length > 0);
  // The observer and its ref share the mounted permissions subtree's lifetime.
  const SharingPermissions = (view: { children: JSX.Element }) => {
    const scroll = useScrollState();
    return (
      <section class="chat-pane__sharing-section chat-pane__sharing-permissions">
        <div class="chat-pane__sharing-section-label chat-pane__sharing-search-heading">
          <span>{t("chat.sessionSharing.messagePermissions")}</span>
          <Show when={people().length > 0}>
            <button
              ref={[
                controls.ref(),
                (element) => {
                  searchToggle = element;
                },
              ]}
              type="button"
              data-form-control=""
              aria-label={t(
                searchOpen()
                  ? "chat.sessionSharing.closeSearch"
                  : "chat.sessionSharing.searchPeople",
              )}
              aria-expanded={searchOpen() ? "true" : "false"}
              onClick={(event) => {
                setImmediate(event.detail === 0);
                if (searchOpen()) {
                  resetSearch(true);
                } else {
                  setSearchOpen(true);
                  flush();
                  search?.focus({ preventScroll: true });
                }
              }}
            >
              <Icon name={searchOpen() ? "x" : "search"} />
            </button>
          </Show>
        </div>
        <Show when={people().length > 0}>
          <div
            class="chat-pane__sharing-disclosure"
            data-open={searchOpen() ? "true" : "false"}
            data-immediate={immediate() ? "true" : "false"}
            inert={!searchOpen()}
          >
            <div class="chat-pane__sharing-disclosure-body">
              <input
                ref={[
                  controls.ref(),
                  (element) => {
                    search = element;
                  },
                ]}
                type="search"
                data-search={searchOpen() ? "" : undefined}
                data-form-control=""
                autocomplete="off"
                class="chat-pane__sharing-search"
                aria-label={t("chat.sessionSharing.searchPeople")}
                placeholder={t("chat.sessionSharing.searchPeople")}
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
          </div>
        </Show>
        <div class="chat-pane__sharing-roster-frame">
          <div
            ref={scroll}
            class="chat-pane__sharing-roster"
            aria-busy={props.state?.loading ? "true" : "false"}
          >
            <Show
              when={matches().length > 0}
              fallback={
                <div class="chat-pane__sharing-empty" role="status">
                  <span>
                    {t(
                      props.state?.loading
                        ? "common.loading"
                        : people().length === 0
                          ? "chat.sessionSharing.noPeople"
                          : "chat.sessionSharing.noPeopleFound",
                    )}
                  </span>
                  <Show when={!props.state?.loading && people().length > 0 && query().trim()}>
                    <span>{t("chat.sessionSharing.tryAnotherName")}</span>
                  </Show>
                </div>
              }
            >
              {view.children}
            </Show>
          </div>
        </div>
      </section>
    );
  };
  const errorItem: MenuEntry = {
    kind: "content",
    id: "error",
    content: (
      <Show when={props.state?.error}>
        <div class="chat-pane__sharing-status chat-pane__sharing-status--error" role="alert">
          {props.state?.error}
        </div>
      </Show>
    ),
  };
  const overviewItems = createMemo(
    (): readonly MenuEntry[] => [
      {
        kind: "content",
        id: "access-label",
        content: (
          <div class="chat-pane__sharing-section-label">
            {t("chat.sessionSharing.sessionAccess")}
          </div>
        ),
      },
      {
        id: "access",
        get label() {
          return t("chat.sessionSharing.sessionAccess");
        },
        class: "chat-pane__sharing-access-trigger",
        closeOnSelect: false,
        content: <SharingModeContent visibility={visibility()} />,
        details: <Icon name="chevronRight" />,
      },
      {
        kind: "content",
        id: "link-sharing",
        content: (
          <section class="chat-pane__sharing-section">
            <div class="chat-pane__sharing-section-label">
              {t("chat.sessionSharing.linkSharing")}
            </div>
            <button
              ref={controls.ref()}
              type="button"
              data-form-control=""
              class="chat-pane__sharing-public-toggle"
              role="switch"
              data-value={result()?.publicShare ? "public:disable" : "public:enable"}
              aria-checked={result()?.publicShare ? "true" : "false"}
              disabled={
                !props.onPublicShareChange ||
                Boolean(props.publicShareDisabledReason || props.state?.loading || !result())
              }
              title={props.publicShareDisabledReason}
              onClick={(event) => {
                setImmediate(event.detail === 0);
                setCopied(false);
                setCopyError("");
                void select(result()?.publicShare ? "public:disable" : "public:enable");
              }}
            >
              <Icon name="globe" />
              <span>{t("chat.sessionSharing.anyoneWithLink")}</span>
              <span class="settings-toggle chat-pane__sharing-switch" aria-hidden="true">
                <span class="settings-toggle__control" />
              </span>
            </button>
            <div
              class="chat-pane__sharing-disclosure"
              data-open={result()?.publicShare ? "true" : "false"}
              data-immediate={immediate() ? "true" : "false"}
              inert={!result()?.publicShare}
            >
              <div class="chat-pane__sharing-disclosure-body">
                <p class="chat-pane__sharing-link-description">
                  {t(
                    visibility() === "draft"
                      ? "chat.sessionSharing.publicDraftDescription"
                      : "chat.sessionSharing.publicLinkDescription",
                  )}
                </p>
                <button
                  ref={controls.ref()}
                  type="button"
                  data-form-control=""
                  data-value="public:copy"
                  class="chat-pane__sharing-url"
                  disabled={
                    !result()?.publicShare || !props.onCopyPublicLink || props.state?.loading
                  }
                  aria-label={t(copied() ? "common.copied" : "chat.sessionSharing.copyPublicLink")}
                  title={props.state?.publicUrl}
                  onClick={() => void select("public:copy")}
                >
                  <span class="chat-pane__sharing-url-text">
                    {props.state?.publicUrl ?? t("chat.sessionSharing.linkUnavailable")}
                  </span>
                  <Icon name={copied() ? "check" : "copy"} />
                </button>
                <Show when={copyError()}>
                  <div class="chat-pane__sharing-status--error" role="alert">
                    {copyError()}
                  </div>
                </Show>
              </div>
            </div>
          </section>
        ),
      },
      {
        kind: "group",
        id: "permissions",
        get items() {
          return showPermissions() ? rosterItems()().map((item) => item()) : [];
        },
        render: (children) => (
          <Show when={showPermissions()}>
            <SharingPermissions>{children}</SharingPermissions>
          </Show>
        ),
      },
      errorItem,
    ],
    { lazy: true },
  );
  const backItem: MenuEntry = {
    id: "access:back",
    get label() {
      return t("common.back");
    },
    class: "chat-pane__sharing-back",
    icon: <Icon name="arrowLeft" />,
    closeOnSelect: false,
  };
  const items = createMemo(
    () => (accessOpen() ? [backItem, ...accessItems(), errorItem] : overviewItems()),
    { lazy: true },
  );
  return {
    items,
    select,
    ref: (handle: MenuHandle) => {
      menu = handle;
    },
    onOpenChange: (open: boolean) => {
      if (!open) {
        setAccessOpen(false);
        resetSearch();
        setCopied(false);
        setCopyError("");
      }
    },
    onEscape: () => {
      if (accessOpen()) {
        navigateAccess(false);
        return true;
      }
      if (!searchOpen()) {
        return false;
      }
      setImmediate(true);
      resetSearch(true);
      return true;
    },
  };
}

export function ChatSessionSharing(props: ChatSessionSharingProps) {
  const id = createUniqueId();
  const controls = createMenuControls();
  const sharing = useDesktopSharing(props, controls);
  const visibility = () => props.session?.visibility ?? "shared";
  const owner = () => props.state?.result?.owner ?? props.session?.owner?.actor;
  const canManage = () => props.session && canManageChatSessionSharing(props.session);
  const published = () => Boolean(props.state?.result?.publicShare);
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
                  <SessionOwnerChip
                    owner={person()}
                    size="header"
                    attribution="owned"
                    viewingNow={props.ownerViewing}
                  />
                </StandalonePersonLink>
              )}
            </Show>
            <span class="chat-pane__draft-indicator" title={t("chat.sessionSharing.draft")}>
              <ChatSessionSharingModeIcon visibility="draft" />
            </span>
          </Show>
        }
      >
        <Menu
          controls={controls}
          lazy
          id={id}
          ref={sharing.ref}
          class="chat-pane__sharing-menu chat-pane__sharing-menu--desktop"
          panelClass="session-menu chat-pane__sharing-panel"
          label={t("chat.sessionSharing.menu")}
          placement="bottom-end"
          disabled={Boolean(props.openDisabledReason)}
          triggerClass="btn chat-pane__sharing-trigger"
          triggerAttributes={{
            "data-public": published() ? "true" : "false",
            title:
              props.openDisabledReason ??
              (published()
                ? t("chat.sessionSharing.worldReadable")
                : t("chat.sessionSharing.current", {
                    visibility: t(VISIBILITY_LABEL_KEYS[visibility()]),
                  })),
          }}
          trigger={
            <>
              <span class="chat-pane__sharing-trigger-state">
                <Show
                  when={published()}
                  fallback={<ChatSessionSharingModeIcon visibility={visibility()} external />}
                >
                  <Icon name="globe" />
                </Show>
                <Show when={published() || visibility() !== "shared"}>
                  <span>
                    {t(
                      published()
                        ? "chat.sessionSharing.publicIndicator"
                        : VISIBILITY_LABEL_KEYS[visibility()],
                    )}
                  </span>
                </Show>
              </span>
              <Icon name="chevronDown" />
            </>
          }
          items={sharing.items()}
          onBeforeShow={() => {
            if (!props.openDisabledReason) {
              props.onOpen();
            }
          }}
          onSelect={(item) => void sharing.select(item.id)}
          onOpenChange={sharing.onOpenChange}
          onEscape={sharing.onEscape}
        />
      </Show>
    </Show>
  );
}
