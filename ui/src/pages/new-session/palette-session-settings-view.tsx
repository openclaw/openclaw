import { createMemo, createSignal, For, Loading, onSettled, Show } from "solid-js";
import { HeaderSearch } from "../../components/solid/header-search.tsx";
import "../../components/tooltip.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { normalizeAgentTargetLabel } from "../../lib/agents/display.ts";
import { elementRef } from "../../lib/reactive/element-ref.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { resolvePaletteSessionSettings, type SettingsOptions } from "./palette-session-settings.ts";
import { repositoryIssueText } from "./submit-gates.ts";
import { AgentSelect, RequiredSessionPlacement } from "./target-controls-view.tsx";

type SettingsProjection = ReturnType<typeof resolvePaletteSessionSettings>;

export function PaletteSessionSettingsView(properties: {
  id: string;
  options: SettingsOptions;
  registerClose: (close: () => void) => () => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const focusControls = new Set<HTMLElement>();
  const controlRef = () =>
    elementRef((element: HTMLElement) => {
      focusControls.add(element);
      return () => focusControls.delete(element);
    });
  let popover!: PopoverHandle;
  const close = () => {
    setOpen(false);
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
    popover.hide();
    popover.overlay.trigger?.focus({ preventScroll: true });
  };
  onSettled(() => properties.registerClose(close));
  const keydown = nativeListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      popover.overlay.trigger?.focus({ preventScroll: true });
      return;
    }
    if (
      !["ArrowDown", "ArrowUp"].includes(event.key) ||
      !(event.currentTarget instanceof HTMLElement)
    ) {
      return;
    }
    const panel = event.currentTarget;
    const controls = [...focusControls]
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
  function SettingsPlaces() {
    const completion = createMemo(
      () => ({ promise: properties.options.draft.gateway.cloudProfilesRead }),
      { equals: (previous, next) => previous.promise === next.promise },
    );
    const cloudProfilesRead = createMemo(() => completion().promise?.then(() => null));
    const connect = nativeListener("click", () => properties.options.onConnectMachine());
    return (
      <>
        <HeaderSearch
          class="palette-session-settings__heading"
          inputClass="palette-session-settings__search"
          label={t("common.search")}
          placeholder={t("newSession.searchProjects")}
          query={query()}
          autofocus="popover"
          disabled={view().locked}
          controlRef={controlRef}
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
  const folderLabel = () =>
    view().placementLocked
      ? view().machineLabel
      : place().hostedEnvironment
        ? t("newSession.hostedWorkspace")
        : view().projectState.label;
  const worktree = nativeListener("click", () => {
    place().selectWorktree(!place().worktree);
    properties.options.onChange();
  });
  return (
    <>
      <Show when={place().agents().length > 1}>
        <openclaw-tooltip
          class="palette-session-settings__agent"
          prop:content={normalizeAgentTargetLabel(
            place().selectedAgent() ?? { id: place().agentId },
            properties.options.context?.agentIdentity.get(place().agentId),
          )}
        >
          <AgentSelect
            params={{
              agents: place().agents(),
              variant: "compact",
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
        </openclaw-tooltip>
      </Show>
      <Popover
        triggerId={properties.id + "-settings-trigger"}
        triggerClass="palette-session-settings__trigger palette-session-settings__chip"
        triggerTitle={`${view().machineLabel} · ${folderLabel()}`}
        triggerAriaLabel={`${t("commandPalette.newSessionSettings")}: ${view().machineLabel}, ${folderLabel()}`}
        trigger={
          <>
            <Icon name="folder" />
            <span class="palette-session-settings__chip-label">{folderLabel()}</span>
            <span class="palette-session-settings__chip-chevron" aria-hidden="true">
              <Icon name="chevronDown" />
            </span>
          </>
        }
        ref={(handle) => {
          popover = handle;
        }}
        id={properties.id + "-settings-popover"}
        label={t("commandPalette.newSessionSettings")}
        class="palette-session-settings"
        placement="bottom-start"
        disabled={view().locked}
        open={open()}
        onOpenChange={(value) => (value ? setOpen(true) : close())}
      >
        <div class="palette-session-settings__content" ref={keydown}>
          {view().placementLocked ? (
            <RequiredSessionPlacement
              gateway={properties.options.draft.gateway}
              retryRef={controlRef()}
            />
          ) : (
            <SettingsPlaces />
          )}
        </div>
      </Popover>
      {!view().placementLocked && place().checkoutVisible && !place().remoteRepository ? (
        <button
          class="palette-session-settings__chip palette-session-settings__worktree"
          type="button"
          role="switch"
          aria-checked={place().worktree ? "true" : "false"}
          aria-label={t("newSession.checkoutWorktree")}
          title={
            place().remotePlacement
              ? t("newSession.checkoutRemoteLocked")
              : !place().worktreeAvailable()
                ? (repositoryIssueText(place().repository) ?? t("newSession.gitCheckUnavailable"))
                : undefined
          }
          disabled={view().locked || place().remotePlacement}
          ref={worktree}
        >
          <Icon name="gitBranch" />
          <span class="palette-session-settings__chip-label">
            {t("newSession.checkoutWorktree")}
          </span>
        </button>
      ) : undefined}
    </>
  );
}
