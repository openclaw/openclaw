import { For } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { KeyboardShortcut, ShortcutText } from "../../components/solid/kbd.tsx";
import { syncPopoverLabel } from "../../components/web-awesome-popover.ts";
import { KEYBOARD_SHORTCUT_COMBOS } from "../../lib/keyboard-shortcut-contract.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { liveValue } from "../../lib/reactive/live-value.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { onOwnPopoverEvent } from "./new-session-runtime.ts";
import type { PaletteSessionSettings } from "./palette-session-settings.ts";
import { AgentSelect, RequiredSessionPlacement } from "./target-controls-view.tsx";

type SettingsView = ReturnType<PaletteSessionSettings["view"]>;

function SettingsIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M4 7h8m4 0h4M4 17h2m4 0h10" />
      <circle cx="14" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </svg>
  );
}

function SettingsPlaces(props: { view: SettingsView }) {
  const searchValue = liveValue(() => props.view.query);
  const back = nativeListener("click", () => props.view.onShowPlaces(false));
  const connect = nativeListener("click", () => props.view.options.onConnectMachine());
  return (
    <>
      <div class="palette-session-settings__heading">
        <button
          type="button"
          class="palette-session-settings__back"
          aria-label={t("common.back")}
          ref={back}
        >
          <Icon name="arrowLeft" />
        </button>
        <span>{t("newSession.projects")}</span>
      </div>
      <input
        class="palette-session-settings__search"
        type="search"
        aria-label={t("common.search")}
        placeholder={t("common.search")}
        ref={searchValue}
        onInput={(event) => props.view.onQueryInput(event.currentTarget.value)}
      />
      <div class="palette-session-settings__choices">
        <For each={props.view.groups} keyed={(group) => group.machine.id}>
          {(group) => (
            <section aria-label={group().machine.label}>
              <div class="palette-session-settings__machine">{group().machine.label}</div>
              <For each={group().choices} keyed={(choice) => choice.id}>
                {(choice) => (
                  <SettingsPlaceChoice
                    view={props.view}
                    machine={group().machine}
                    choice={choice()}
                  />
                )}
              </For>
              {group().machine.disabledReason ? (
                <div class="palette-session-settings__unavailable">
                  {group().machine.disabledReason}
                </div>
              ) : undefined}
            </section>
          )}
        </For>
        {!props.view.groups.length ? (
          <div class="palette-session-settings__unavailable">
            {t("newSession.environmentSearchEmpty")}
          </div>
        ) : undefined}
        {props.view.options.draft.gateway.cloudProfilesPending ? (
          <div role="status" class="palette-session-settings__unavailable">
            {t("common.loading")}
          </div>
        ) : undefined}
      </div>
      {props.view.options.draft.place.isAdmin() ? (
        <button
          class="palette-session-settings__row"
          type="button"
          disabled={props.view.locked}
          ref={connect}
        >
          <span class="palette-session-settings__icon">
            <Icon name="plus" />
          </span>
          <span>{t("newSession.connectMachine")}</span>
        </button>
      ) : undefined}
    </>
  );
}

function SettingsPlaceChoice(props: {
  view: SettingsView;
  machine: SettingsView["groups"][number]["machine"];
  choice: { id: string; label: string };
}) {
  const selected = () =>
    props.machine.selected &&
    (props.machine.hosted ||
      (props.choice.id
        ? props.view.options.draft.browser.projectId === props.choice.id
        : !props.view.options.draft.browser.projectId &&
          (props.machine.remote
            ? props.view.options.draft.place.freshWorkspace
            : props.view.options.draft.place.folder ===
              props.view.options.draft.place.workspacePath())));
  const choose = nativeListener("click", () => props.view.choose(props.machine, props.choice.id));
  return (
    <button
      type="button"
      class="palette-session-settings__row"
      data-machine={props.machine.id}
      data-project={props.choice.id}
      aria-pressed={selected() ? "true" : "false"}
      title={props.machine.disabledReason}
      disabled={props.view.locked || Boolean(props.machine.disabledReason)}
      ref={choose}
    >
      <span class="palette-session-settings__icon">
        <Icon name={props.choice.id ? "gitBranch" : "folder"} />
      </span>
      <span class="palette-session-settings__label">{props.choice.label}</span>
      <span class="palette-session-settings__check">
        {selected() ? <Icon name="check" /> : undefined}
      </span>
    </button>
  );
}

function SettingsSummary(props: { view: SettingsView }) {
  const workspace = nativeListener("click", (event) =>
    props.view.onShowPlaces(true, event.detail > 0),
  );
  const worktree = nativeListener("click", () => {
    props.view.options.draft.place.selectWorktree(!props.view.options.draft.place.worktree);
    props.view.options.onChange();
  });
  return (
    <>
      <div class="palette-session-settings__title">{t("commandPalette.newSessionSettings")}</div>
      <div class="palette-session-settings__agent">
        <AgentSelect
          params={{
            agents: props.view.options.draft.place.agents(),
            variant: "default",
            agentId: props.view.options.draft.place.agentId,
            agentIdentity: props.view.options.context?.agentIdentity,
            disabled: props.view.locked,
            onSelect: (id) => {
              props.view.options.draft.place.selectAgentId(id);
              props.view.options.onChange();
            },
            onOpenChange: props.view.options.onAgentPickerOpen,
          }}
        />
      </div>
      {props.view.placementLocked ? (
        <RequiredSessionPlacement gateway={props.view.options.draft.gateway} />
      ) : (
        <>
          <button
            class="palette-session-settings__row palette-session-settings__workspace"
            type="button"
            disabled={props.view.locked}
            ref={workspace}
          >
            <span class="palette-session-settings__icon">
              <Icon name="folder" />
            </span>
            <span class="palette-session-settings__copy">
              <span class="palette-session-settings__label">
                {props.view.options.draft.place.hostedEnvironment
                  ? t("newSession.hostedWorkspace")
                  : props.view.projectState.label}
              </span>
              <span class="palette-session-settings__secondary">
                {props.view.machineLabel}
                {props.view.cloudSummary ? " · " + props.view.cloudSummary : ""}
              </span>
            </span>
            <span class="palette-session-settings__chevron">
              <Icon name="chevronRight" />
            </span>
          </button>
          {props.view.options.draft.place.checkoutVisible &&
          !props.view.options.draft.place.remoteRepository ? (
            <button
              class="palette-session-settings__row palette-session-settings__worktree"
              type="button"
              role="switch"
              aria-checked={props.view.options.draft.place.worktree ? "true" : "false"}
              aria-label={t("newSession.checkoutWorktree")}
              title={
                props.view.options.draft.place.remotePlacement
                  ? t("newSession.checkoutRemoteLocked")
                  : !props.view.options.draft.place.worktreeAvailable()
                    ? t("newSession.gitCheckUnavailable")
                    : undefined
              }
              disabled={props.view.locked || props.view.options.draft.place.remotePlacement}
              ref={worktree}
            >
              <span class="palette-session-settings__icon">
                <Icon name="gitBranch" />
              </span>
              <span>{t("newSession.checkoutWorktree")}</span>
              <span class="palette-session-settings__switch" aria-hidden="true" />
            </button>
          ) : undefined}
        </>
      )}
    </>
  );
}

export function PaletteSessionSettingsView(props: { view: SettingsView }) {
  const keydown = nativeListener("keydown", (event) => props.view.onKeydown(event));
  const retry = nativeListener("click", () => props.view.options.preferences.retry());
  return (
    <>
      <button
        id={props.view.id + "-settings-trigger"}
        class="palette-session-settings__trigger"
        type="button"
        aria-label={t("commandPalette.newSessionSettings")}
        title={t("commandPalette.newSessionSettings")}
        aria-haspopup="dialog"
        aria-expanded={props.view.open ? "true" : "false"}
      >
        <SettingsIcon />
      </button>
      <wa-popover
        ref={syncPopoverLabel}
        class="palette-session-settings"
        for={props.view.id + "-settings-trigger"}
        placement="bottom-end"
        without-arrow
        prop:open={props.view.open}
        onWa-show={onOwnPopoverEvent(() => props.view.onOpen())}
        onWa-hide={onOwnPopoverEvent(() => props.view.onHide())}
      >
        <div class="palette-session-settings__content" ref={keydown}>
          {props.view.places ? (
            <SettingsPlaces view={props.view} />
          ) : (
            <SettingsSummary view={props.view} />
          )}
          {!props.view.places || props.view.options.preferences.failed ? (
            <div class="palette-session-settings__footer">
              {!props.view.places ? (
                <label
                  class="palette-session-settings__remember"
                  title={
                    !props.view.options.preferences.available
                      ? t("commandPalette.rememberUnavailable")
                      : undefined
                  }
                >
                  <input
                    type="checkbox"
                    checked={props.view.options.preferences.remember}
                    disabled={props.view.locked || !props.view.options.preferences.available}
                    onChange={(event) =>
                      props.view.options.preferences.setRemember(event.currentTarget.checked)
                    }
                  />
                  <span>
                    <ShortcutText
                      text={t("commandPalette.rememberSettings", { shortcut: "{shortcut}" })}
                      shortcut={() => (
                        <KeyboardShortcut combo={KEYBOARD_SHORTCUT_COMBOS.commandPalette} inline />
                      )}
                    />
                  </span>
                </label>
              ) : undefined}
              {props.view.options.preferences.failed ? (
                <div class="palette-session-settings__error" role="alert">
                  {t("commandPalette.settingsSaveFailed")}{" "}
                  <button type="button" class="btn btn--sm" ref={retry}>
                    {t("common.retry")}
                  </button>
                </div>
              ) : undefined}
            </div>
          ) : undefined}
        </div>
      </wa-popover>
    </>
  );
}
