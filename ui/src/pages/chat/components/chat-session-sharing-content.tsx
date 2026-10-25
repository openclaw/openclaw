import type { JSX } from "@solidjs/web";
import {
  createMemo,
  createSignal,
  isPending,
  latest,
  Loading,
  mapArray,
  merge,
  onSettled,
  Show,
} from "solid-js";
import type { SessionVisibility } from "../../../api/types.ts";
import { PersonAvatarLink, PersonName } from "../../../components/person-activity-link-solid.tsx";
import { personActivityLink } from "../../../components/person-activity-link.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import type {
  MenuControls,
  MenuEntry,
  MenuHandle,
  MenuItem,
} from "../../../components/solid/menu.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { SessionOwnerChip } from "../../../components/solid/session-owner-chip.tsx";
import { StrokeIcon } from "../../../components/solid/stroke-icon.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  type ChatSessionSharingProps,
  VISIBILITY_LABEL_KEYS,
  CHAT_SESSION_SHARING_DESCRIPTION_KEYS,
  createChatSessionSharingPresentation,
  ChatSessionSharingModeIcon,
  ChatSessionSharingError,
  projectChatSessionSharingRoster,
  chatSessionPermissionLabel,
} from "./chat-session-sharing-shared.tsx";
import type { ChatSessionSharingContentProps } from "./chat-session-sharing.solid.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

function SharingModeContent(props: { visibility: SessionVisibility }) {
  return (
    <>
      <span class="chat-pane__sharing-mode-icon">
        <Show
          when={props.visibility === "read-only"}
          fallback={<ChatSessionSharingModeIcon visibility={props.visibility} />}
        >
          <StrokeIcon aria-hidden="true">
            <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
            <path d="M7 11h10M7 15h6M7 7h8" />
          </StrokeIcon>
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
  const presentation = createChatSessionSharingPresentation(() => props);
  const busy = () => presentation.busy() || props.state?.loading === true;
  const completion = presentation.completion;
  // Preserve the empty-roster status shown after a command failure.
  const commandFailed = createMemo(async () => Boolean(await completion()?.catch(() => true)), {
    loadingValue: false,
  });
  let menu: MenuHandle | undefined;
  let search: HTMLInputElement | undefined;
  let searchToggle: HTMLButtonElement | undefined;
  const scope = presentation.scope;
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
  const [copyCompletion, setCopyCompletion] = createSignal<Promise<void> | undefined>(() => {
    scope();
    return undefined;
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
  const people = createMemo(() => projectChatSessionSharingRoster(props));
  const matches = createMemo(() => {
    const terms = query().trim().toLocaleLowerCase().split(/\s+/u);
    return people().filter(({ identity }) =>
      terms.every((term) =>
        `${identity.label ?? ""} ${identity.id} ${identity.type}`
          .toLocaleLowerCase()
          .includes(term),
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
    }
    const pending = presentation.select(value);
    if (value === "public:copy") {
      const completed = pending.then((outcome) => {
        if (scope() === selectedScope && menu?.overlay.open && outcome?.status === "failed") {
          throw new Error(outcome.error);
        }
      });
      void setCopyCompletion(completed);
      void completed.catch(() => undefined);
    }
    const outcome = await pending;
    if (scope() !== selectedScope || !menu?.overlay.open || !outcome) {
      return;
    }
    if (value === "public:copy") {
      setCopied(outcome?.status === "success");
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
          return !allowed().includes(mode) || Boolean(props.visibilityDisabledReason || busy());
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
        (row) => {
          const person = () => row().identity;
          const isCreator = () => row().owner;
          const reason = () => row().disabledReason;
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
            </>
          );
          const branch: MenuEntry = {
            id: `permission:${person().id}`,
            get label() {
              return `${person().label ?? person().id}, ${row().controlLabel}`;
            },
            class: "chat-pane__sharing-permission",
            get disabled() {
              return !busy() && Boolean(reason());
            },
            get attributes(): MenuItem["attributes"] {
              return {
                title: reason(),
                "aria-disabled": busy() ? "true" : undefined,
              };
            },
            get trigger() {
              return row().controlLabel;
            },
            onBeforeShow(event) {
              if (busy()) {
                event.preventDefault();
              }
            },
            get children() {
              return row().options.map((level) => ({
                id: `permission:${level}:${person().id}`,
                label: chatSessionPermissionLabel(level),
                type: "radio" as const,
                checked: row().level === level,
                closeOnSelect: false,
              }));
            },
          };
          return {
            kind: "group",
            id: `member:${person().id}`,
            get items() {
              return row().fixed ? [] : [branch];
            },
            render: (renderItems) => (
              <div
                class={[
                  "chat-pane__sharing-person",
                  { "chat-pane__sharing-person--creator": isCreator() },
                ]}
                data-value={`member:${person().id}`}
              >
                <Content />
                <Show
                  when={row().fixed}
                  fallback={
                    <div class="chat-pane__sharing-permission-control">
                      {renderItems(() => [branch])}
                    </div>
                  }
                >
                  <span class="chat-pane__sharing-permission">{row().controlLabel}</span>
                </Show>
              </div>
            ),
          } satisfies MenuEntry;
        },
        { keyed: (row) => row.identity.id },
      ),
    { lazy: true },
  );
  const showPermissions = () =>
    visibility() !== "shared" &&
    visibility() !== "draft" &&
    props.membersAvailable !== false &&
    (!result() ||
      Boolean(props.state?.read) ||
      Boolean(props.state?.error) ||
      (!presentation.busy() && latest(commandFailed)) ||
      people().length > 0);
  const permissionItems = () => (showPermissions() ? rosterItems()() : []);
  // The observer and its ref share the mounted permissions subtree's lifetime.
  const SharingPermissions = (view: { children: JSX.Element }) => {
    const scroll = useScrollState();
    return (
      <section class="chat-pane__sharing-section chat-pane__sharing-permissions">
        <div class="chat-pane__sharing-section-label chat-pane__sharing-search-heading">
          <span>{t("chat.sessionSharing.permissions")}</span>
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
                  const selectedScope = scope();
                  setSearchOpen(true);
                  onSettled(() => {
                    if (scope() === selectedScope && menu?.overlay.open && searchOpen()) {
                      search?.focus({ preventScroll: true });
                    }
                  });
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
          <Loading
            on={presentation.scope()}
            fallback={
              <div class="chat-pane__sharing-roster">
                <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />
              </div>
            }
          >
            {(latest(presentation.read), null)}
            <div
              ref={scroll}
              class="chat-pane__sharing-roster"
              aria-busy={isPending(presentation.read) || busy() ? "true" : "false"}
            >
              <Show
                when={matches().length > 0}
                fallback={
                  <div class="chat-pane__sharing-empty" role="status">
                    <span>
                      {t(
                        people().length === 0
                          ? "chat.sessionSharing.noPeople"
                          : "chat.sessionSharing.noPeopleFound",
                      )}
                    </span>
                    <Show when={people().length > 0 && query().trim()}>
                      <span>{t("chat.sessionSharing.tryAnotherName")}</span>
                    </Show>
                  </div>
                }
              >
                {view.children}
              </Show>
            </div>
          </Loading>
        </div>
      </section>
    );
  };
  const errorItem: MenuEntry = {
    kind: "content",
    id: "error",
    content: (
      <ChatSessionSharingError
        error={props.state?.error}
        completion={completion()}
        pending={presentation.busy()}
      >
        {(error) => (
          <div class="chat-pane__sharing-status chat-pane__sharing-status--error" role="alert">
            {error}
          </div>
        )}
      </ChatSessionSharingError>
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
                Boolean(props.publicShareDisabledReason || busy() || !result())
              }
              title={props.publicShareDisabledReason}
              onClick={(event) => {
                setImmediate(event.detail === 0);
                setCopied(false);
                setCopyCompletion(undefined);
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
                  disabled={!result()?.publicShare || !props.onCopyPublicLink || busy()}
                  aria-label={t(copied() ? "common.copied" : "chat.sessionSharing.copyPublicLink")}
                  title={props.state?.publicUrl}
                  onClick={() => void select("public:copy")}
                >
                  <span class="chat-pane__sharing-url-text">
                    {props.state?.publicUrl ?? t("chat.sessionSharing.linkUnavailable")}
                  </span>
                  <Icon name={copied() ? "check" : "copy"} />
                </button>
                <ChatSessionSharingError
                  completion={copyCompletion()}
                  pending={presentation.busy()}
                >
                  {(error) => (
                    <div class="chat-pane__sharing-status--error" role="alert">
                      {error}
                    </div>
                  )}
                </ChatSessionSharingError>
              </div>
            </div>
          </section>
        ),
      },
      {
        kind: "group",
        id: "permissions",
        get items() {
          return permissionItems();
        },
        render: (renderItems) => (
          <Show when={showPermissions()}>
            <SharingPermissions>{renderItems(permissionItems)}</SharingPermissions>
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
        setCopyCompletion(undefined);
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

export function ChatSessionSharingContent(inputs: ChatSessionSharingContentProps) {
  const controls: MenuControls = {
    get elements() {
      return inputs.controls.elements;
    },
    ref: () => inputs.controls.ref(),
  };
  const sharing = useDesktopSharing(
    merge(() => inputs.sharing),
    controls,
  );
  onSettled(() => {
    const handle = inputs.readMenu();
    if (handle) {
      sharing.ref(handle);
    }
    inputs.onReady(sharing);
    return () => inputs.onReady(undefined);
  });
  return <>{inputs.renderItems(sharing.items)}</>;
}
