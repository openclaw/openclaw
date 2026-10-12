import type { JSX } from "@solidjs/web";
import { For, createMemo, createSignal } from "solid-js";
import { SESSION_COMMUNICATION_MODES } from "../../../packages/gateway-protocol/src/session-communication.js";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import type {
  SessionMenuActions,
  SessionManagementActionKind,
  SessionMenuActionsState as MenuState,
} from "./session-menu-actions.ts";
import { SessionMenuItem } from "./session-menu-item.tsx";
import type { SessionOwnerOption } from "./session-owner-chip.ts";
import { Icon } from "./solid/icon.tsx";
import { SessionOwnerAvatar } from "./solid/session-owner-chip.tsx";

function OwnerAvatar(props: { owner: SessionOwnerOption }) {
  return (
    <span slot="icon" class="session-menu__avatar" aria-hidden="true">
      <SessionOwnerAvatar owner={props.owner} />
    </span>
  );
}

export function useSessionMenuDetails(
  actions: SessionMenuActions,
  readState: () => MenuState,
  disabled: (kind: SessionManagementActionKind) => boolean,
  revision: () => number,
) {
  const OwnerStatus = (props: { inline?: boolean }) => {
    const status = createMemo(() => {
      revision();
      return actions.ownerMenu.snapshot;
    });
    return (
      <>
        {!status().connected ? undefined : status().loading ? (
          <SessionMenuItem slot={props.inline ? undefined : "submenu"} disabled={true}>
            {t("common.loading")}
          </SessionMenuItem>
        ) : status().error ? (
          <>
            <div
              slot={props.inline ? undefined : "submenu"}
              class="session-menu__info"
              role="alert"
            >
              {formatUiError(status().error, t("common.failed"))}
            </div>
            <SessionMenuItem
              class="session-menu__item"
              slot={props.inline ? undefined : "submenu"}
              value="reload-owners"
            >
              <span class="session-menu__text">{t("common.retry")}</span>
            </SessionMenuItem>
          </>
        ) : undefined}
      </>
    );
  };
  const OwnerOptions = (props: { inline: boolean }) => {
    const [search, setSearch] = createSignal({
      generation: actions.ownerMenu.snapshot.searchGeneration,
      query: "",
    });
    const snapshot = createMemo(() => {
      revision();
      return actions.ownerMenu.snapshot;
    });
    const query = () => (search().generation === snapshot().searchGeneration ? search().query : "");
    const owners = () => {
      const state = snapshot();
      const options = [...state.owners];
      const currentOwner = readState().currentOwner;
      const id = currentOwner?.identity?.id ?? currentOwner?.id;
      if (
        !state.directory &&
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
    };
    const entries = createMemo(() => {
      const current = readState().currentOwner;
      return owners().map((owner) => ({
        owner,
        checked:
          owner.type === current?.type && owner.id === (current?.identity?.id ?? current?.id),
      }));
    });
    return (
      <>
        <div
          slot={props.inline ? undefined : "submenu"}
          class="people-menu__search"
          ref={nativeListener("click", (event) => event.stopPropagation())}
        >
          <input
            type="search"
            autocomplete="off"
            aria-label={t("sessionsView.searchPeople")}
            placeholder={t("sessionsView.searchPeople")}
            value={query()}
            onInput={(event) =>
              setSearch({
                generation: snapshot().searchGeneration,
                query: event.currentTarget.value,
              })
            }
            ref={nativeListener("keydown", (event) => {
              if (event.key === "Escape" || event.key === "Tab") {
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
              const input = event.target;
              if (!(input instanceof HTMLInputElement)) {
                return;
              }
              let row = input.parentElement?.nextElementSibling;
              while (row?.localName === "wa-dropdown-item") {
                if (row instanceof HTMLElement && !row.hasAttribute("disabled")) {
                  row.focus();
                  return;
                }
                row = row.nextElementSibling;
              }
            })}
          />
        </div>
        <For each={entries()} keyed={(entry) => `${entry.owner.type}:${entry.owner.id}`}>
          {(entry) => {
            return (
              <SessionMenuItem
                class="session-menu__item"
                slot={props.inline ? undefined : "submenu"}
                value={`assign-owner:${entry().owner.type}:${encodeURIComponent(entry().owner.id)}`}
                checked={entry().checked}
                disabled={actions.actionDisabled("assign-owner") || entry().checked}
                title={readState().actionDisabledReasons["assign-owner"]}
              >
                <OwnerAvatar owner={entry().owner} />
                <span class="session-menu__text">
                  {entry().owner === snapshot().self
                    ? t("sessionsView.assignToMe")
                    : (entry().owner.label ?? entry().owner.id)}
                </span>
                {entry().checked ? (
                  <span slot="details" class="session-menu__check" aria-hidden="true">
                    <Icon name="check" />
                  </span>
                ) : undefined}
              </SessionMenuItem>
            );
          }}
        </For>
        {owners().length === 0 ? (
          <div
            slot={props.inline ? undefined : "submenu"}
            class="people-menu__status"
            role="status"
          >
            {t("sessionsView.noPeopleMatch")}
          </div>
        ) : undefined}
        <OwnerStatus inline={props.inline} />
      </>
    );
  };
  const Communication = (props: { inline: boolean }): JSX.Element => {
    const snapshot = createMemo(() => {
      revision();
      return actions.advanced.communicationState();
    });
    const policy = () => snapshot().session.communication;
    const effective = () => snapshot().session.effectiveCommunication;
    const reason = () => readState().actionDisabledReasons["set-communication"];
    return (
      <>
        <div
          slot={props.inline ? undefined : "submenu"}
          class="session-menu__separator"
          role="separator"
        />
        <div slot={props.inline ? undefined : "submenu"} class="session-menu__communication">
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
                            value={`communication:${direction}:${mode}`}
                            aria-pressed={effective()?.[direction] === mode ? "true" : "false"}
                            disabled={!effective() || disabled("set-communication")}
                            title={
                              reason() ??
                              (policy()?.[direction] === undefined &&
                              effective()?.[direction] === mode
                                ? t("sessionsView.communication.default")
                                : undefined)
                            }
                            ref={(element) => {
                              click(element);
                              keydown(element);
                            }}
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
        {policy()?.send !== undefined || policy()?.receive !== undefined ? (
          <SessionMenuItem
            class="session-menu__item"
            slot={props.inline ? undefined : "submenu"}
            value="communication:reset"
            disabled={!effective() || disabled("set-communication")}
            title={reason() ?? t("sessionsView.communication.resetDescription")}
          >
            <span class="session-menu__text">{t("common.reset")}</span>
          </SessionMenuItem>
        ) : undefined}
      </>
    );
  };
  const error = createMemo(() => {
    revision();
    return actions.advanced.error;
  });
  return { OwnerStatus, OwnerOptions, Communication, error };
}
