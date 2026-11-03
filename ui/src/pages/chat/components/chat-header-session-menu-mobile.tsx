import type { JSX } from "@solidjs/web";
import { For, Show, createProjection, createSignal, mapArray, merge, onSettled } from "solid-js";
import type { useSessionMenuEntries } from "../../../components/session-menu-view.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import {
  Menu,
  type MenuEntry,
  type MenuItem,
  type MenuItemBindings,
} from "../../../components/solid/menu.tsx";
import { registerSessionMenuEnglish } from "../../../i18n/locales/en-session-menu.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createPendingFocus } from "../../../lib/reactive/pending-focus.ts";
import type { SessionCreatedActor } from "../../../lib/session-owner.ts";

registerSessionMenuEnglish();

export type HeaderSessionMenuPage = {
  key: "session-assign" | "session-group" | "session-advanced" | "session-appearance";
  title: string;
  content: JSX.Element;
  backTo?: HeaderSessionMenuPage;
  expandable: boolean;
  headerActions?: JSX.Element;
  presentation?: "sheet";
  resizable?: boolean;
};

/** The pane's mobile host owns navigation, visibility, Back and focus restoration. */
export type HeaderSessionMenuMobileHost = {
  open(page: HeaderSessionMenuPage, source: HTMLElement): void;
  close(): void;
  isCurrent(page: HeaderSessionMenuPage): boolean;
};

const plainLabel = (label: string) => label.replace(/(?:…|\.{3})$/u, "");
const isItem = (entry: MenuEntry): entry is MenuItem =>
  entry.kind !== "content" && entry.kind !== "group";

function PageEntries(props: {
  entries: readonly MenuEntry[];
  select: (item: MenuItem, event?: MouseEvent) => void;
}) {
  const entries = createProjection(() => props.entries, [], { key: "id" });
  return (
    <For each={entries}>
      {(entry) => {
        if (entry.kind === "content") {
          return entry.content;
        }
        if (entry.kind === "group") {
          return <PageEntries entries={entry.items} select={props.select} />;
        }
        if (entry.children) {
          return (
            <Menu
              id={`mobile-session-${entry.id}`}
              label={plainLabel(entry.label)}
              trigger={plainLabel(entry.label)}
              triggerClass="session-actions-page__row"
              items={typeof entry.children === "function" ? entry.children() : entry.children}
              onSelect={(item) => props.select(item)}
            />
          );
        }
        const activate = (event: MouseEvent) => {
          if (!entry.disabled) {
            props.select(entry, event);
          }
        };
        if (entry.render) {
          return entry.render(
            merge((): MenuItemBindings => ({
              role: entry.type === "radio" ? "radio" : "button",
              "aria-label": plainLabel(entry.label),
              "aria-disabled": entry.disabled ? "true" : "false",
              "aria-checked": entry.checked ? "true" : "false",
              onClick: activate,
            })),
          );
        }
        return (
          <button
            type="button"
            class={[
              "session-actions-page__row",
              { "session-actions-page__row--danger": entry.variant === "danger" },
            ]}
            disabled={entry.disabled}
            title={entry.attributes?.title}
            aria-pressed={entry.type ? (entry.checked ? "true" : "false") : undefined}
            onClick={activate}
          >
            {entry.type === "checkbox" ? <Icon name="eye" /> : entry.icon}
            <span>{plainLabel(entry.label)}</span>
            {entry.type === "checkbox" ? (
              <span
                class="session-actions-page__switch"
                data-checked={entry.checked ? "true" : "false"}
                aria-hidden="true"
              />
            ) : entry.checked ? (
              <Icon name="check" />
            ) : entry.id.startsWith("compact:open-") ? (
              <Icon name="chevronRight" />
            ) : undefined}
          </button>
        );
      }}
    </For>
  );
}

export function createMobileHeaderSessionMenu(options: {
  view: ReturnType<typeof useSessionMenuEntries>;
  currentOwner: () => SessionCreatedActor | null;
  category: () => string | null | undefined;
  viewOptions: () => MenuEntry[];
  host: () => HeaderSessionMenuMobileHost | undefined;
  source: () => HTMLElement | undefined;
  closeMenu: () => void;
  select: (item: MenuItem) => void;
}) {
  type PageKind = "assign-owner" | "group" | "advanced" | "icon";
  type PageRequest = {
    kind: PageKind;
    page: HeaderSessionMenuPage;
    host: HeaderSessionMenuMobileHost;
    source: HTMLElement;
    keyboardSource?: HTMLElement;
  };
  const [pageRequests, setPageRequests] = createSignal<PageRequest[]>([]);
  const body = (name: "assign-owner" | "group" | "advanced" | "icon" | "open-in") =>
    options.view
      .compact(name)
      .filter((entry) => !entry.id.startsWith("compact:back") && entry.id !== "back-divider");
  const select = (item: MenuItem) => {
    // Restore the trigger before pane removal starts its survivor-focus handoff.
    const closeBeforeAction = item.id === "open-command-palette" || item.id === "layout:close-pane";
    if (closeBeforeAction) {
      options.host()?.close();
    }
    options.select(item);
    if (
      !closeBeforeAction &&
      item.closeOnSelect !== false &&
      !item.id.startsWith("communication:")
    ) {
      options.host()?.close();
    }
  };
  // Keep Back pages alive under the menu owner until their navigation chain is replaced.
  const pageViews = mapArray(pageRequests, (request) => {
    const { kind, page, host, source, keyboardSource } = request;
    const [focusArmed, setFocusArmed] = createSignal(false);
    const [focusReady, setFocusReady] = createSignal(false);
    let contentRoot: HTMLDivElement | undefined;
    let focusCancelled = false;
    const [query, setQuery] = createSignal("");
    const [searchOpen, setSearchOpen] = createSignal(false);
    const entries = () => {
      const rows = body(kind);
      if (kind === "assign-owner") {
        return [
          ...rows.filter((entry) => entry.id === "owners-search"),
          {
            id: "unassigned",
            label: t("sessionsView.unassigned"),
            disabled: true,
            checked: !options.currentOwner(),
            type: "radio" as const,
            attributes: { title: t("sessionsView.actionUnavailable") },
          },
          ...rows.filter((entry) => entry.id !== "owners-search"),
        ];
      }
      if (kind !== "group") {
        return rows;
      }
      const groups = rows.filter(
        (entry) => entry.id.startsWith("move-to-group:") && entry.id !== "move-to-group:",
      );
      groups.sort((a, b) => (isItem(a) ? a.label : "").localeCompare(isItem(b) ? b.label : ""));
      return [
        ...groups.filter(
          (entry) =>
            isItem(entry) &&
            entry.label.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase()),
        ),
        ...rows.filter((entry) => !groups.includes(entry)),
      ];
    };
    const view = {
      page,
      headerActions:
        kind === "group" ? (
          <button
            type="button"
            class="chat-mobile-host__circle"
            aria-label={t("sessionsView.searchGroups")}
            aria-expanded={searchOpen() ? "true" : "false"}
            onClick={() => {
              setSearchOpen((value) => !value);
              setQuery("");
            }}
          >
            <Icon name="search" />
          </button>
        ) : undefined,
      content: (
        <div
          ref={(element) => (contentRoot = element)}
          class={[
            "session-actions-page",
            {
              "session-actions-page--appearance": kind === "icon",
              "session-actions-page--group-picker": kind === "group",
              "session-actions-page--advanced": kind === "advanced",
            },
          ]}
        >
          {kind === "group" && searchOpen() ? (
            <label class="session-actions-page__search">
              <Icon name="search" />
              <input
                type="search"
                autocomplete="off"
                aria-label={t("sessionsView.searchGroups")}
                placeholder={t("sessionsView.searchGroups")}
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
          ) : undefined}
          {kind === "advanced" ? (
            <>
              <section>
                <h3>{t("sessionsView.mobileConversation")}</h3>
                <div class="session-actions-page__group">
                  <PageEntries
                    entries={options
                      .viewOptions()
                      .filter((entry) =>
                        [
                          "view:reasoning",
                          "view:tool-calls",
                          "view:commentary",
                          "view:speech-bubbles",
                        ].includes(entry.id),
                      )}
                    select={select}
                  />
                </div>
              </section>
              <section>
                <h3>{t("sessionsView.session")}</h3>
                <div class="session-actions-page__group">
                  <PageEntries
                    entries={body("advanced")
                      .filter(
                        (entry) =>
                          !entry.id.includes("copy") &&
                          !entry.id.includes("open-in") &&
                          !entry.id.startsWith("communication") &&
                          entry.id !== "delete-divider",
                      )
                      .flatMap((entry) =>
                        entry.id === "delete"
                          ? options
                              .viewOptions()
                              .filter((action) => action.id === "layout:close-pane")
                              .concat(entry)
                          : [entry],
                      )}
                    select={(item, event) =>
                      item.id === "compact:open-icon"
                        ? openPage(
                            "icon",
                            page,
                            event?.detail === 0 && event.currentTarget instanceof HTMLElement
                              ? event.currentTarget
                              : undefined,
                          )
                        : select(item)
                    }
                  />
                </div>
              </section>
              <section>
                <h3>{t("sessionsView.communication.title")}</h3>
                <div class="session-actions-page__group session-actions-page__communication">
                  <PageEntries
                    entries={body("advanced").filter(
                      (entry) =>
                        entry.id === "communication-controls" || entry.id === "communication:reset",
                    )}
                    select={select}
                  />
                </div>
              </section>
              <section>
                <h3>{t("sessionsView.openInEditorMenu")}</h3>
                <div class="session-actions-page__group">
                  <PageEntries entries={body("open-in")} select={select} />
                </div>
              </section>
            </>
          ) : kind === "icon" ? (
            options.view.appearance.render(true, () => setFocusReady(true))
          ) : (
            <div class="session-actions-page__group">
              <PageEntries entries={entries()} select={select} />
            </div>
          )}
        </div>
      ),
    };
    if (keyboardSource) {
      const canFocus = () => {
        const active = source.ownerDocument.activeElement;
        return (
          !focusCancelled &&
          source.isConnected &&
          host.isCurrent(page) &&
          contentRoot?.isConnected === true &&
          (active === source.ownerDocument.body || active === source || active === keyboardSource)
        );
      };
      createPendingFocus(
        () => ({
          armed: focusArmed(),
          ready: focusReady(),
          current: host.isCurrent(page),
        }),
        {
          requested: (next, previous) => {
            if (!next.armed) {
              return false;
            }
            if (!next.current) {
              focusCancelled = true;
              return false;
            }
            return previous?.armed ? undefined : true;
          },
          ready: (next) => next.ready && contentRoot?.isConnected === true,
          focus: () => options.view.appearance.focusFirst(canFocus),
        },
      );
      // Navigation and the picker ref settle before this one entry request is armed.
      onSettled(() => {
        setFocusArmed(true);
        return () => {
          focusCancelled = true;
        };
      });
    }
    return view;
  });
  const openPage = (
    kind: PageKind,
    backTo?: HeaderSessionMenuPage,
    keyboardSource?: HTMLElement,
  ): void => {
    const host = options.host();
    const source = options.source();
    if (!host || !source) {
      return;
    }
    if (kind === "icon") {
      options.view.appearance.prepare();
    }
    const page: HeaderSessionMenuPage = {
      key:
        kind === "assign-owner"
          ? "session-assign"
          : kind === "group"
            ? "session-group"
            : kind === "icon"
              ? "session-appearance"
              : "session-advanced",
      title: plainLabel(
        t(
          kind === "assign-owner"
            ? "sessionsView.assignTo"
            : kind === "group"
              ? "sessionsView.moveToGroupMenu"
              : kind === "icon"
                ? "sessionsView.setIconColorMenu"
                : "sessionsView.advanced",
        ),
      ),
      expandable: kind === "advanced" || kind === "icon",
      presentation: kind === "group" ? "sheet" : undefined,
      resizable: kind === "group",
      backTo,
      get headerActions() {
        return (
          <Show when={pageViews().find((view) => view.page === page)} keyed>
            {(view) => view.headerActions}
          </Show>
        );
      },
      get content() {
        return (
          <Show when={pageViews().find((view) => view.page === page)} keyed>
            {(view) => view.content}
          </Show>
        );
      },
    };
    options.closeMenu();
    host.open(page, source);
    // The host receives navigation synchronously; its getters render under keyed page owners.
    const retained = new Set<HeaderSessionMenuPage>();
    for (let current: HeaderSessionMenuPage | undefined = page; current; current = current.backTo) {
      retained.add(current);
    }
    setPageRequests((previous) => [
      ...previous.filter((request) => retained.has(request.page)),
      { kind, page, host, source, keyboardSource },
    ]);
  };
  function root(entries: readonly MenuEntry[]): MenuEntry[] {
    const native = entries.filter(isItem);
    const copyLink = native.find((entry) => entry.id === "copy-session-link");
    const copies = options.view
      .compact("copy")
      .filter(isItem)
      .filter((entry) => !entry.id.startsWith("compact:"));
    const copyOrder = ["copy-session-preview-link", "copy-session-id", "copy-markdown"];
    copies.sort((a, b) => copyOrder.indexOf(a.id) - copyOrder.indexOf(b.id));
    const hidden = new Set([
      "open-command-palette",
      "compact:open-view",
      "compact:open-sharing",
      "compact:open-advanced",
      "submenu:view",
      "submenu:sharing",
      "submenu:advanced",
      "copy-session-link",
    ]);
    const order = [
      "toggle-pin",
      "rename",
      "toggle-unread",
      "compact:open-assign-owner",
      "compact:open-group",
      "toggle-archived",
    ];
    const rows = native.filter((entry) => !hidden.has(entry.id));
    rows.sort(
      (a, b) =>
        (order.includes(a.id) ? order.indexOf(a.id) : order.length) -
        (order.includes(b.id) ? order.indexOf(b.id) : order.length),
    );
    return [
      ...rows.map((entry): MenuItem => {
        const owner = options.currentOwner();
        const subtitle =
          entry.id === "compact:open-assign-owner"
            ? (owner?.label ?? owner?.id ?? t("sessionsView.unassigned"))
            : entry.id === "compact:open-group"
              ? options.category()
              : undefined;
        return Object.assign({}, entry, {
          label: plainLabel(entry.label),
          attributes: { title: entry.attributes?.title },
          content: (
            <span class="session-actions__label">
              <span>{plainLabel(entry.label)}</span>
              {subtitle ? <small>{subtitle}</small> : undefined}
            </span>
          ),
          details: entry.id.startsWith("compact:open-") ? <Icon name="chevronRight" /> : undefined,
        });
      }),
      {
        kind: "content",
        id: "mobile-copy-divider",
        content: <div class="session-menu__separator" role="separator" />,
      },
      {
        id: "mobile-copy",
        label: t("common.copy"),
        icon: <Icon name="copy" />,
        class: "session-menu__item",
        closeOnSelect: false,
        details: <Icon name="chevronRight" />,
        children: [...(copyLink ? [copyLink] : []), ...copies].map((entry) => {
          const label =
            entry.id === "copy-session-preview-link"
              ? t("sessionsView.mobileCopyPreviewLink")
              : entry.id === "copy-session-id"
                ? t("sessionsView.mobileCopySessionId")
                : entry.id === "copy-markdown"
                  ? t("sessionsView.mobileCopyMarkdown")
                  : entry.label;
          return Object.assign({}, entry, {
            label,
            content: <span class="session-menu__text">{label}</span>,
            attributes: { title: entry.attributes?.title },
            details: undefined,
          });
        }),
      },
      {
        id: "mobile-advanced",
        label: t("sessionsView.advanced"),
        icon: <Icon name="settings" />,
        class: "session-menu__item",
        details: <Icon name="chevronRight" />,
        closeOnSelect: false,
      },
    ];
  }
  return {
    root,
    open(value: string): boolean {
      const kind =
        value === "mobile-advanced"
          ? "advanced"
          : value === "compact:open-assign-owner"
            ? "assign-owner"
            : value === "compact:open-group"
              ? "group"
              : null;
      if (!kind) {
        return false;
      }
      openPage(kind);
      return true;
    },
  };
}
