import { createMemo, createSignal, For, latest, Loading, onSettled } from "solid-js";
import { Checkbox } from "../../components/solid/checkbox.tsx";
import { HeaderSearch } from "../../components/solid/header-search.tsx";
import "../../components/tooltip.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { KeyboardShortcut, ShortcutText } from "../../components/solid/kbd.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { StrokeIcon } from "../../components/solid/stroke-icon.tsx";
import { SwitchIndicator } from "../../components/solid/switch.tsx";
import { keyboardHints } from "../../lib/keyboard-hints.ts";
import { KEYBOARD_SHORTCUT_COMBOS } from "../../lib/keyboard-shortcut-contract.ts";
import { elementRef } from "../../lib/reactive/element-ref.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { resolvePaletteSessionSettings, type SettingsOptions } from "./palette-session-settings.ts";
import { createPresentationAction } from "./submission-action.ts";
import { repositoryIssueText } from "./submit-gates.ts";
import { AgentSelect, RequiredSessionPlacement } from "./target-controls-view.tsx";

type SettingsProjection = ReturnType<typeof resolvePaletteSessionSettings>;

function SettingsIcon() {
  return (
    <StrokeIcon width="24" height="24">
      <path d="M4 7h8m4 0h4M4 17h2m4 0h10" />
      <circle cx="14" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </StrokeIcon>
  );
}

export function PaletteSessionSettingsView(properties: {
  id: string;
  options: SettingsOptions;
  registerClose: (close: () => void) => () => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [projectOpen, setProjectOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  let searchInput: HTMLInputElement | undefined;
  const focusControls = new Set<HTMLElement>();
  const controlRef = () =>
    elementRef((element: HTMLElement) => {
      focusControls.add(element);
      return () => focusControls.delete(element);
    });
  let readAgentControls: (() => readonly HTMLElement[]) | undefined;
  let popover!: PopoverHandle;
  let projectPopover!: PopoverHandle;
  const close = (preferences: SettingsOptions["preferences"]) => {
    preferences.retirePresentation();
    setOpen(false);
    setProjectOpen(false);
    setQuery("");
  };
  const view = createMemo(() => resolvePaletteSessionSettings(properties.options, query()));
  const selectMachine = (
    machine: SettingsProjection["groups"][number]["machine"],
    projectId?: string,
  ) => {
    if (view().locked || machine.disabledReason) {
      return;
    }
    machine.select();
    const place = properties.options.draft.place;
    if (!machine.hosted) {
      if (projectId) {
        place.selectProjectId(projectId);
      } else if (machine.remote) {
        place.selectNewWorkspace();
      } else {
        place.applyFolder(place.workspacePath());
      }
    }
    properties.options.onChange();
    projectPopover.hide();
    projectPopover.overlay.trigger?.focus({ preventScroll: true });
  };
  onSettled(() => {
    const preferences = properties.options.preferences;
    const unregister = properties.registerClose(() => close(preferences));
    return () => {
      preferences.retirePresentation();
      unregister();
    };
  });
  const keydown = nativeListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
      return;
    }
    // Nested menus own Escape and roving focus, including their triggers.
    if (
      event
        .composedPath()
        .some(
          (node) =>
            node instanceof Element &&
            node.matches(
              '[role="menu"], [role="listbox"], [aria-haspopup="menu"], [aria-haspopup="listbox"]',
            ),
        )
    ) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const handle = projectPopover.overlay.open ? projectPopover : popover;
      handle.hide();
      handle.overlay.trigger?.focus({ preventScroll: true });
      return;
    }
    if (
      !["ArrowDown", "ArrowUp"].includes(event.key) ||
      !(event.currentTarget instanceof HTMLElement)
    ) {
      return;
    }
    const panel = event.currentTarget;
    const controls = [...focusControls, ...(readAgentControls?.() ?? [])]
      // Arrows walk the field and the choices; Tab still reaches the field's clear button.
      .filter(
        (control) =>
          panel.contains(control) &&
          !control.matches(":disabled") &&
          !control.matches(".header-search__clear"),
      )
      .toSorted((left, right) =>
        left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
    if (!controls.length) {
      return;
    }
    const current = controls.findIndex((control) => control === panel.ownerDocument.activeElement);
    event.preventDefault();
    event.stopPropagation();
    controls[
      (current + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length
    ]?.focus();
  });
  const failed = createMemo(() => properties.options.preferences.failed);
  const { saving, submit } = createPresentationAction(
    () => properties.options.preferences,
    (owner) => owner.presentationLifetime,
    open,
    failed,
    (owner) => owner.reportFailure(),
  );
  const save = async (operation: () => Promise<void> | undefined) => submit(operation);
  const retry = nativeListener(
    "click",
    () => void save(() => properties.options.preferences.retry()),
  );
  function SettingsPlaces() {
    const completion = createMemo(
      () => ({ promise: properties.options.draft.gateway.cloudProfilesRead }),
      { equals: (previous, next) => previous.promise === next.promise },
    );
    const cloudProfilesRead = createMemo(() => completion().promise?.then(() => null));
    onSettled(() => {
      if (keyboardHints.visible()) {
        searchInput?.focus({ preventScroll: true });
      }
    });
    const connect = nativeListener("click", () => properties.options.onConnectMachine());
    return (
      <>
        <HeaderSearch
          class="palette-session-settings__heading"
          inputClass="palette-session-settings__search"
          label={t("common.search")}
          placeholder={t("newSession.searchProjects")}
          query={query()}
          controlRef={controlRef}
          inputRef={(node) => {
            searchInput = node;
          }}
          onQueryChange={setQuery}
        />
        <div class="palette-session-settings__choices">
          <For each={view().groups} keyed={(group) => group.machine.id}>
            {(group) => (
              <section aria-label={group().machine.label}>
                <div class="palette-session-settings__machine">{group().machine.label}</div>
                <For each={group().choices} keyed={(choice) => choice.id}>
                  {(choice) => <SettingsPlaceChoice machine={group().machine} choice={choice()} />}
                </For>
              </section>
            )}
          </For>
          {!view().groups.length ? (
            <div class="palette-session-settings__unavailable">
              {t("newSession.environmentSearchEmpty")}
            </div>
          ) : undefined}
          <Loading
            on={completion()}
            fallback={
              <div role="status" class="palette-session-settings__unavailable">
                {t("common.loading")}
              </div>
            }
          >
            {cloudProfilesRead()}
          </Loading>
        </div>
        {properties.options.draft.place.isAdmin() ? (
          <button
            class="palette-session-settings__row"
            type="button"
            disabled={view().locked}
            ref={[controlRef(), connect]}
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
    machine: SettingsProjection["groups"][number]["machine"];
    choice: { id: string; label: string };
  }) {
    const selected = () =>
      props.machine.selected &&
      (props.machine.hosted ||
        (props.choice.id
          ? properties.options.draft.browser.projectId === props.choice.id
          : !properties.options.draft.browser.projectId &&
            (props.machine.remote
              ? properties.options.draft.place.freshWorkspace
              : properties.options.draft.place.folder ===
                properties.options.draft.place.workspacePath())));
    const choose = nativeListener("click", () => selectMachine(props.machine, props.choice.id));
    const row = () => (
      <button
        type="button"
        class="palette-session-settings__row"
        data-machine={props.machine.id}
        data-project={props.choice.id}
        aria-pressed={selected() ? "true" : "false"}
        aria-description={props.machine.disabledReason}
        aria-disabled={props.machine.disabledReason ? "true" : undefined}
        disabled={view().locked}
        ref={[controlRef(), choose]}
      >
        <span class="palette-session-settings__icon" aria-hidden="true">
          <Icon
            name={
              props.machine.disabledReason
                ? "alertTriangle"
                : props.choice.id
                  ? "gitBranch"
                  : "folder"
            }
          />
        </span>
        <span class="palette-session-settings__label">{props.choice.label}</span>
        <span class="palette-session-settings__check">
          {selected() ? <Icon name="check" /> : undefined}
        </span>
      </button>
    );
    return (
      <>
        {props.machine.disabledReason ? (
          <openclaw-tooltip
            class="palette-session-settings__reason"
            placement="right-start"
            prop:openOnClick={true}
            prop:content={props.machine.disabledReason}
          >
            {row()}
          </openclaw-tooltip>
        ) : (
          row()
        )}
      </>
    );
  }

  const place = () => properties.options.draft.place;
  const worktree = nativeListener("click", () => {
    place().selectWorktree(!place().worktree);
    properties.options.onChange();
  });
  const projectLabel = () =>
    view().placementLocked
      ? view().machineLabel
      : place().hostedEnvironment
        ? t("newSession.hostedWorkspace")
        : view().projectState.label;
  const projectDescription = () =>
    [
      projectLabel(),
      !view().placementLocked && view().machineLabel,
      view().cloudSummary,
      place().worktree && t("newSession.checkoutWorktree"),
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <>
      <Popover
        triggerId={properties.id + "-settings-trigger"}
        triggerClass="palette-session-settings__trigger"
        triggerTitle={t("commandPalette.newSessionSettings")}
        trigger={<SettingsIcon />}
        ref={(handle) => {
          popover = handle;
        }}
        id={properties.id + "-settings-popover"}
        label={t("commandPalette.newSessionSettings")}
        class="palette-session-settings"
        placement="bottom-start"
        open={open()}
        onOpenChange={(value) => {
          setOpen(value);
          if (value) {
            projectPopover.hide();
          } else {
            properties.options.preferences.retirePresentation();
          }
        }}
      >
        <div class="palette-session-settings__content" ref={keydown}>
          <div class="palette-session-settings__title">
            {t("commandPalette.newSessionSettings")}
          </div>
          <div class="palette-session-settings__agent">
            <AgentSelect
              focusTargetsRef={(readTargets) => {
                readAgentControls = readTargets;
              }}
              params={{
                agents: place().agents(),
                variant: "default",
                agentId: place().agentId,
                agentIdentity: properties.options.context?.agentIdentity,
                disabled: view().locked,
                onSelect: (id) => {
                  place().selectAgentId(id);
                  properties.options.onChange();
                },
                identityTargetsRef: properties.options.identityTargetsRef,
                onIdentityTargetsChange: properties.options.onIdentityTargetsChange,
              }}
            />
          </div>
          <div class="palette-session-settings__footer" aria-busy={saving() ? "true" : "false"}>
            <label
              class="palette-session-settings__remember"
              title={
                !properties.options.preferences.available
                  ? t("commandPalette.rememberUnavailable")
                  : undefined
              }
            >
              <Checkbox
                ref={[controlRef()]}
                checked={properties.options.preferences.remember}
                disabled={view().locked || !properties.options.preferences.available}
                onChange={(event) =>
                  void save(() =>
                    properties.options.preferences.setRemember(event.currentTarget.checked),
                  )
                }
              />
              <span>
                <ShortcutText
                  fallback={t("commandPalette.rememberSettingsNoShortcut")}
                  text={t("commandPalette.rememberSettings", { shortcut: "{shortcut}" })}
                  shortcut={() => (
                    <KeyboardShortcut combo={KEYBOARD_SHORTCUT_COMBOS.commandPalette} inline />
                  )}
                />
              </span>
            </label>
            {latest(failed) ? (
              <div class="palette-session-settings__error" role="alert">
                {t("commandPalette.settingsSaveFailed")}{" "}
                <button type="button" class="btn btn--sm" ref={[controlRef(), retry]}>
                  {t("common.retry")}
                </button>
              </div>
            ) : undefined}
          </div>
        </div>
      </Popover>
      <Popover
        triggerId={properties.id + "-project-trigger"}
        triggerClass="palette-session-settings__workspace"
        triggerTitle={projectDescription()}
        triggerAriaLabel={t("sessionHovercard.projectLabel") + ": " + projectDescription()}
        trigger={
          <>
            <Icon name={place().worktree ? "gitBranch" : "folder"} />
            <span>{projectLabel()}</span>
            <Icon name="chevronDown" />
          </>
        }
        id={properties.id + "-project-popover"}
        label={t("sessionHovercard.projectLabel")}
        class="palette-session-settings palette-session-project"
        placement="bottom-start"
        disabled={view().locked}
        ref={(handle) => {
          projectPopover = handle;
        }}
        open={projectOpen()}
        onOpenChange={(value) => {
          setProjectOpen(value);
          if (value) {
            popover.hide();
          } else {
            setQuery("");
          }
        }}
      >
        <div class="palette-session-settings__content" ref={keydown}>
          {view().placementLocked ? (
            <RequiredSessionPlacement
              gateway={properties.options.draft.gateway}
              retryRef={controlRef()}
            />
          ) : (
            <>
              {projectOpen() ? <SettingsPlaces /> : undefined}
              {place().checkoutVisible && !place().remoteRepository ? (
                <button
                  class="palette-session-settings__row palette-session-settings__worktree"
                  type="button"
                  role="switch"
                  aria-checked={place().worktree ? "true" : "false"}
                  aria-label={t("newSession.checkoutWorktree")}
                  title={
                    place().remotePlacement
                      ? t("newSession.checkoutRemoteLocked")
                      : !place().worktreeAvailable()
                        ? (repositoryIssueText(place().repository) ??
                          t("newSession.gitCheckUnavailable"))
                        : undefined
                  }
                  disabled={view().locked || place().remotePlacement}
                  ref={[controlRef(), worktree]}
                >
                  <span class="palette-session-settings__icon">
                    <Icon name="gitBranch" />
                  </span>
                  <span>{t("newSession.checkoutWorktree")}</span>
                  <span class="palette-session-settings__switch">
                    <SwitchIndicator checked={place().worktree} size="sm" />
                  </span>
                </button>
              ) : undefined}
            </>
          )}
        </div>
      </Popover>
    </>
  );
}
