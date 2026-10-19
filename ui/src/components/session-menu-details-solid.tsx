import { For, Show, createMemo, createSignal } from "solid-js";
import { SESSION_COMMUNICATION_MODES } from "../../../packages/gateway-protocol/src/session-communication.js";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import { formatUiError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import type {
  SessionMenuActions,
  SessionManagementActionKind,
  SessionMenuActionsState as MenuState,
} from "./session-menu-actions.ts";
import { Icon } from "./solid/icon.tsx";
import type { MenuControls, MenuEntry } from "./solid/menu.tsx";
import { SessionOwnerAvatar } from "./solid/session-owner-chip.tsx";

registerSessionOrganizationEnglish();

export function useSessionMenuDetails(
  actions: SessionMenuActions,
  readState: () => MenuState,
  disabled: (kind: SessionManagementActionKind) => boolean,
  controls?: MenuControls,
) {
  const ownerSnapshot = actions.ownerMenu.snapshot;
  const ownerStatus = (): MenuEntry[] => {
    const status = ownerSnapshot();
    if (!status.connected) {
      return [];
    }
    if (status.loading) {
      return [{ id: "owners-loading", label: t("common.loading"), disabled: true }];
    }
    return status.error
      ? [
          {
            kind: "content",
            id: "owners-error",
            content: (
              <div class="session-menu__info" role="alert">
                {formatUiError(status.error, t("common.failed"))}
              </div>
            ),
          },
          {
            id: "reload-owners",
            label: t("common.retry"),
            class: "session-menu__item",
            content: <span class="session-menu__text">{t("common.retry")}</span>,
          },
        ]
      : [];
  };
  const searchGeneration = createMemo(() => ownerSnapshot().searchGeneration);
  const [query, setQuery] = createSignal(() => {
    searchGeneration();
    return "";
  });
  const owners = createMemo(() => {
    const state = ownerSnapshot();
    const options = [...state.owners];
    const currentOwner = readState().currentOwner;
    const id = currentOwner?.identity?.id ?? currentOwner?.id;
    if (
      currentOwner?.type === "human" &&
      id &&
      !options.some((owner) => owner.type === "human" && owner.id === id)
    ) {
      options.push({ ...currentOwner, type: "human", id });
    }
    const terms = query().trim().toLocaleLowerCase().split(/\s+/u);
    return options.filter((owner) =>
      terms.every((term) =>
        [
          owner.label,
          owner.id,
          owner.type,
          owner === state.self ? t("sessionsView.assignToMe") : "",
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(term),
      ),
    );
  });
  const ownersByKey = createMemo(
    () => new Map(owners().map((owner) => [`${owner.type}:${owner.id}`, owner])),
  );
  const ownerSearchEntry: MenuEntry = {
    kind: "content",
    id: "owners-search",
    content: (
      <div
        class="people-menu__search"
        ref={nativeListener("click", (event) => event.stopPropagation())}
      >
        <input
          ref={controls?.ref()}
          type="search"
          data-search
          data-form-control
          autocomplete="off"
          aria-label={t("sessionsView.searchPeople")}
          placeholder={t("sessionsView.searchPeople")}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
    ),
  };
  const ownerOptions = (): MenuEntry[] => {
    const current = readState().currentOwner;
    const options = owners();
    return [
      ownerSearchEntry,
      ...options.map((owner): MenuEntry => {
        const checked =
          owner.type === current?.type && owner.id === (current?.identity?.id ?? current?.id);
        const label =
          owner === ownerSnapshot().self ? t("sessionsView.assignToMe") : (owner.label ?? owner.id);
        return {
          id: `assign-owner:${owner.type}:${encodeURIComponent(owner.id)}`,
          label,
          class: "session-menu__item",
          type: "radio",
          checked,
          disabled: actions.actionDisabled("assign-owner") || checked,
          attributes: { title: readState().actionDisabledReasons["assign-owner"] },
          render: (attributes) => (
            <button
              {...attributes}
              type="button"
              value={`assign-owner:${owner.type}:${encodeURIComponent(owner.id)}`}
              class="oc-menu-item session-menu__item"
              disabled={attributes["aria-disabled"] === "true"}
              title={readState().actionDisabledReasons["assign-owner"]}
            >
              <span class="oc-menu-item__check" aria-hidden="true">
                {attributes["aria-checked"] === "true" ? "✓" : ""}
              </span>
              <span class="oc-menu-item__icon">
                <span class="session-menu__avatar" aria-hidden="true">
                  <SessionOwnerAvatar
                    owner={ownersByKey().get(`${owner.type}:${owner.id}`) ?? owner}
                  />
                </span>
              </span>
              <span class="oc-menu-item__label">
                <span class="session-menu__text">{attributes["aria-label"]}</span>
              </span>
              <Show when={attributes["aria-checked"] === "true"}>
                <span class="oc-menu-item__details">
                  <span class="session-menu__check" aria-hidden="true">
                    <Icon name="check" />
                  </span>
                </span>
              </Show>
            </button>
          ),
        };
      }),
      ...(options.length === 0
        ? [
            {
              kind: "content" as const,
              id: "owners-empty",
              content: (
                <div class="people-menu__status" role="status">
                  {t("sessionsView.noPeopleMatch")}
                </div>
              ),
            },
          ]
        : []),
      ...ownerStatus(),
    ];
  };
  const communicationSnapshot = createMemo(() => actions.advanced.communicationState());
  const policy = () => communicationSnapshot().session.communication;
  const effective = () => communicationSnapshot().session.effectiveCommunication;
  const reason = () => readState().actionDisabledReasons["set-communication"];
  const communicationControls = (
    <div class="session-menu__communication">
      <h3 class="session-menu__communication-heading">{t("sessionsView.communication.title")}</h3>
      <For each={["send", "receive"] as const}>
        {(direction) => {
          const label = () =>
            t(
              direction === "send"
                ? "sessionsView.communication.send"
                : "sessionsView.communication.receive",
            );
          return (
            <div class="session-menu__communication-row" title={reason()}>
              <span class="session-menu__text">{label()}</span>
              <div class="session-menu__communication-picker" role="group" aria-label={label()}>
                <For each={SESSION_COMMUNICATION_MODES}>
                  {(mode) => {
                    const click = nativeListener("click", (event) => {
                      event.stopPropagation();
                      actions.handleSelect(`communication:${direction}:${mode}`);
                    });
                    const keydown = nativeListener("keydown", (event) => {
                      if (event.key !== "Escape" && event.key !== "Tab") {
                        event.stopPropagation();
                      }
                    });
                    return (
                      <button
                        type="button"
                        class="session-menu__communication-choice"
                        data-form-control
                        value={`communication:${direction}:${mode}`}
                        aria-pressed={effective()?.[direction] === mode ? "true" : "false"}
                        disabled={!effective() || disabled("set-communication")}
                        title={
                          reason() ??
                          (policy()?.[direction] === undefined && effective()?.[direction] === mode
                            ? t("sessionsView.communication.default")
                            : undefined)
                        }
                        ref={[controls?.ref(), click, keydown]}
                      >
                        {t(
                          mode === "always"
                            ? "sessionsView.communication.always"
                            : mode === "ask"
                              ? "sessionsView.communication.ask"
                              : "sessionsView.communication.never",
                        )}
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
  const communicationStart: MenuEntry = {
    kind: "content",
    id: "communication-start",
    content: <div class="session-menu__separator" role="separator" />,
  };
  const communicationEnd: MenuEntry = {
    kind: "content",
    id: "communication-end",
    content: <div class="session-menu__separator" role="separator" />,
  };
  const communication = (): MenuEntry[] => [
    communicationStart,
    { kind: "content", id: "communication-controls", content: communicationControls },
    ...(policy()?.send !== undefined || policy()?.receive !== undefined
      ? [
          {
            id: "communication:reset",
            label: t("common.reset"),
            class: "session-menu__item",
            disabled: !effective() || disabled("set-communication"),
            attributes: { title: reason() ?? t("sessionsView.communication.resetDescription") },
            content: <span class="session-menu__text">{t("common.reset")}</span>,
          },
        ]
      : []),
    communicationEnd,
  ];
  const error = () => actions.advanced.error;
  return { ownerStatus, ownerOptions, communication, error };
}
