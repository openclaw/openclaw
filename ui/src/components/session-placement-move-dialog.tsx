import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Errored, For, Loading, onSettled, Show } from "solid-js";
import type { SessionMoveTarget } from "../../../packages/gateway-protocol/src/index.js";
import { registerNewSessionSetupEnglish } from "../i18n/locales/en-new-session-setup.ts";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import { registerSessionPlacementEnglish } from "../i18n/locales/en-session-placement.ts";
import { formatUiError } from "../lib/format-error.ts";
import { elementRef } from "../lib/reactive/element-ref.ts";
import { t } from "../lib/reactive/i18n.ts";
import {
  machineShapeText,
  type CloudChoiceMenuItemsOptions,
} from "../pages/new-session/cloud-target.ts";
import type { DevicePlacementOption } from "../pages/new-session/device-placement.ts";
import type { DraftCloudProfile } from "../pages/new-session/discovery.ts";
import { DraftCloudMachineState } from "../pages/new-session/draft-cloud-machine-state.ts";
import "../styles/session-placement-move.css";
import { withPromiseModalHost } from "./promise-modal-host.ts";
import { resolveCloudProfileIconData } from "./provider-icon-data.ts";
import { observeScrollState } from "./scroll-state-observer.ts";
import { Icon } from "./solid/icon.tsx";
import { Menu } from "./solid/menu.tsx";
import { CloudProfileIcon } from "./solid/provider-icon.tsx";

registerSessionOrganizationEnglish();

registerNewSessionSetupEnglish();
registerSessionPlacementEnglish();

type Catalog = {
  profiles: readonly DraftCloudProfile[];
  devices: readonly DevicePlacementOption[];
};

export type SessionPlacementSource = {
  label: string;
  target?: SessionMoveTarget;
  providerId?: string;
};

/** The parent owns navigation and mounts render once; release removes that mount. */
export type SessionPlacementPresentation = (request: {
  title: string;
  render: () => JSX.Element;
  cancel: () => void;
}) => () => void;

export type SessionPlacementTargetOptions = {
  mode: "dispatch" | "move" | "restart";
  sessionLabel: string;
  activeRun: boolean;
  source?: SessionPlacementSource;
  presentation?: SessionPlacementPresentation;
  repositoryOnly?: boolean;
  allowMachineOverrides?: boolean;
  gatewayDisabledReason?: string;
  deviceDisabledReason?: string;
  profileDisabledReason?: (profile: DraftCloudProfile) => string | undefined;
  loadCatalog: () => Promise<Catalog>;
};

type Destination = {
  key: string;
  label: string;
  subtitle?: string;
  facts?: readonly string[];
  disabledReason?: string;
  target: SessionMoveTarget;
  profile?: DraftCloudProfile;
};

let active = false;

function targetKey(target: SessionMoveTarget | null | undefined): string {
  if (!target) {
    return "";
  }
  return target.kind === "gateway"
    ? "gateway"
    : `${target.kind === "profile" ? "cloud" : "device"}:${target.kind === "profile" ? target.profileId : target.deviceId}`;
}

export function showSessionPlacementTargetDialog(
  options: SessionPlacementTargetOptions,
): Promise<SessionMoveTarget | null> {
  if (active) {
    return Promise.resolve(null);
  }
  active = true;
  const title = t(`sessionsView.${options.mode}SessionTitle`);
  const result = options.presentation
    ? new Promise<SessionMoveTarget | null>((resolve, reject) => {
        let release: (() => void) | undefined;
        let settled = false;
        const finish = (target: SessionMoveTarget | null) => {
          if (settled) {
            return;
          }
          settled = true;
          release?.();
          resolve(target);
        };
        try {
          release = options.presentation!({
            title,
            cancel: () => finish(null),
            render: () => renderSessionPlacementPicker(options, finish, true),
          });
          if (settled) {
            release();
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(formatUiError(error)));
        }
      })
    : withPromiseModalHost<SessionMoveTarget | null>(undefined, ({ finish, render }) => {
        render(() => (
          <openclaw-modal-dialog
            class="session-move-modal"
            label={title}
            onModal-cancel={() => finish(null)}
          >
            {renderSessionPlacementPicker(options, finish)}
          </openclaw-modal-dialog>
        ));
      });
  return result.finally(() => {
    active = false;
  });
}

function renderSessionPlacementPicker(
  options: SessionPlacementTargetOptions,
  finish: (target: SessionMoveTarget | null) => void,
  inline = false,
) {
  const catalog = createMemo(() => options.loadCatalog());
  const [selected, select] = createSignal<SessionMoveTarget | null>(null);
  const [machineRevision, setMachineRevision] = createSignal(0);
  const sourceTarget = options.source?.target;
  const cloudMachines = createMemo(() => {
    const profiles = catalog().profiles;
    const machines = new DraftCloudMachineState();
    if (sourceTarget?.kind !== "profile") {
      return machines;
    }
    const profile = profiles.find((entry) => entry.id === sourceTarget.profileId);
    if (!profile) {
      return machines;
    }
    // Running machines can outlive catalog choices. Seed only supported values;
    // the native state owner supplies defaults for a removed class or OS.
    const operatingSystems = profile.operatingSystems?.filter((os) => !os.disabledReason);
    const os =
      operatingSystems?.find((entry) => entry.id === sourceTarget.os) ??
      operatingSystems?.find((entry) => entry.default) ??
      operatingSystems?.[0];
    if (os) {
      machines.selectOs(profile.id, os.id, profiles);
    }
    if (sourceTarget.machineClass) {
      machines.select(profile.id, sourceTarget.machineClass, profiles);
    }
    return machines;
  });
  const selectedKey = createMemo(() => targetKey(selected()));
  const dispatch = options.mode === "dispatch";
  const warning = options.mode === "restart" || (!dispatch && options.activeRun);
  const notice = {
    restart: "restartSessionWarning",
    dispatch: options.repositoryOnly ? "dispatchSessionNotice" : "dispatchLocalSessionNotice",
    move: options.activeRun ? "moveSessionActiveRunWarning" : "moveSessionNoReplayWarning",
  }[options.mode];
  const sort = (rows: Destination[]) =>
    rows.toSorted(
      (left, right) =>
        Number(Boolean(left.disabledReason)) - Number(Boolean(right.disabledReason)) ||
        left.label.localeCompare(right.label) ||
        left.key.localeCompare(right.key),
    );
  const devices = createMemo(() =>
    sort(
      catalog().devices.map((device): Destination => ({
        key: `device:${device.deviceId}`,
        label: device.label,
        subtitle: device.subtitle,
        facts: device.facts,
        disabledReason:
          options.deviceDisabledReason ??
          device.disabledReason ??
          (!device.selectable ? t("newSession.deviceUnavailable") : undefined),
        target: { kind: "device", deviceId: device.deviceId },
      })),
    ),
  );
  const servers = createMemo(() =>
    sort([
      ...(!dispatch
        ? [
            {
              key: "gateway",
              label: t("newSession.gateway"),
              target: { kind: "gateway" } as const,
              disabledReason: options.gatewayDisabledReason,
            },
          ]
        : []),
      ...catalog().profiles.map((profile): Destination => ({
        key: `cloud:${profile.id}`,
        label: profile.id,
        profile,
        target: { kind: "profile", profileId: profile.id },
        disabledReason: options.profileDisabledReason?.(profile),
        facts: [
          profile.trust === "disposable"
            ? t("newSession.environmentDisposable")
            : profile.trust === "persistent"
              ? t("newSession.environmentPersistent")
              : "",
          profile.inference === "worker" ? t("sessionsView.inferenceWorker") : "",
        ].filter(Boolean),
      })),
    ]),
  );
  const rows = createMemo(() => [...devices(), ...servers()]);
  const effectiveTarget = createMemo(() => {
    machineRevision();
    const target = selected();
    if (target?.kind !== "profile" || options.allowMachineOverrides === false) {
      return target;
    }
    const { machineClass, os } = cloudMachines().selection(target.profileId, catalog().profiles);
    return { ...target, ...(machineClass ? { machineClass } : {}), ...(os ? { os } : {}) };
  });
  const unchanged = createMemo(() => {
    const target = effectiveTarget();
    if (!sourceTarget || !target || targetKey(sourceTarget) !== targetKey(target)) {
      return false;
    }
    return (
      target.kind !== "profile" ||
      sourceTarget.kind !== "profile" ||
      (target.machineClass === sourceTarget.machineClass && target.os === sourceTarget.os)
    );
  });
  const selectable = () =>
    selected() !== null &&
    !unchanged() &&
    rows().some((row) => row.key === selectedKey() && !row.disabledReason);
  const sourceLabel = createMemo(() => {
    if (sourceTarget?.kind === "device") {
      return (
        catalog().devices.find((device) => device.deviceId === sourceTarget.deviceId)?.label ??
        options.source?.label
      );
    }
    return options.source?.label;
  });
  const tabKey = () => selectedKey() || rows().find((row) => !row.disabledReason)?.key;
  const destinationButtons = new Map<string, HTMLButtonElement>();
  const registerButton = (key: string, button: HTMLButtonElement) => {
    destinationButtons.set(key, button);
    return () => {
      if (destinationButtons.get(key) === button) {
        destinationButtons.delete(key);
      }
    };
  };
  let scroller!: HTMLDivElement;
  let observation: ReturnType<typeof observeScrollState> | undefined;
  onSettled(() => {
    observation = observeScrollState(scroller, (state) => {
      scroller.dataset.atStart = String(state.atStart);
      scroller.dataset.atEnd = String(state.atEnd);
      scroller.dataset.scrollable = String(state.scrollable);
    });
    const resize = new ResizeObserver(() => observation?.schedule());
    if (scroller.firstElementChild) {
      resize.observe(scroller.firstElementChild);
    }
    return () => {
      resize.disconnect();
      observation?.disconnect();
    };
  });
  const navigate = (event: KeyboardEvent) => {
    if (
      !event.target ||
      !(event.target instanceof HTMLElement) ||
      event.target.getAttribute("role") !== "radio"
    ) {
      return;
    }
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    const buttons = rows().flatMap((row) => {
      const button = destinationButtons.get(row.key);
      return button?.isConnected && !button.disabled && !button.closest("[inert]") && !button.hidden
        ? [button]
        : [];
    });
    const index = buttons.findIndex((button) => button === event.target);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index +
              (event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1) +
              buttons.length) %
            buttons.length;
    const button = buttons[next];
    const row = rows().find((candidate) => candidate.key === button?.dataset.value);
    if (button && row) {
      event.preventDefault();
      select(row.target);
      button.focus();
    }
  };
  const config = (profile: DraftCloudProfile) => (
    <CloudConfiguration
      profile={profile}
      profiles={catalog().profiles}
      machines={cloudMachines()}
      revision={machineRevision()}
      onChange={() => setMachineRevision((value) => value + 1)}
    />
  );
  const SourceRow = (props: { label: string | undefined }) => (
    <Show when={props.label}>
      <div class="session-move__from">
        <span>{t("sessionsView.moveFrom")}</span>
        <span class="session-move__origin">
          {sourceTarget?.kind === "profile" ? (
            <CloudProfileIcon
              profile={
                options.source?.providerId ? { providerId: options.source.providerId } : undefined
              }
            />
          ) : (
            <Icon name={sourceTarget?.kind === "device" ? "monitor" : "server"} />
          )}
          <span title={props.label}>{props.label}</span>
        </span>
      </div>
    </Show>
  );
  return (
    <form
      class={["session-move", { "session-move--inline": inline }]}
      onSubmit={(event: Event) => {
        event.preventDefault();
        if (selectable()) {
          finish(effectiveTarget());
        }
      }}
    >
      <Show when={!inline}>
        <header class="session-move__header">
          <h2>{t(`sessionsView.${options.mode}SessionTitle`)}</h2>
          <button
            type="button"
            class="session-move__close"
            aria-label={t("common.close")}
            onClick={() => finish(null)}
          >
            <Icon name="x" />
          </button>
        </header>
      </Show>
      <div
        class="session-move__scroll"
        ref={(element) => {
          scroller = element;
        }}
        onKeyDown={navigate}
      >
        <div class="session-move__body">
          <Errored fallback={(_error) => <SourceRow label={options.source?.label} />}>
            <Loading fallback={<SourceRow label={options.source?.label} />}>
              <SourceRow label={sourceLabel()} />
            </Loading>
          </Errored>
          <p class="session-move__description">
            {t(`sessionsView.${options.mode}SessionDescription`, { session: options.sessionLabel })}
          </p>
          <div role="radiogroup" aria-label={t(`sessionsView.${options.mode}SessionTitle`)}>
            <Errored
              fallback={(error, reset) => (
                <div class="session-move__status" role="alert">
                  <p>{formatUiError(error(), t("sessionsView.moveSessionCatalogFailed"))}</p>
                  <button type="button" class="btn" onClick={reset}>
                    {t("common.retry")}
                  </button>
                </div>
              )}
            >
              <Loading
                fallback={
                  <div class="session-move__status" role="status">
                    {t("common.loading")}
                  </div>
                }
              >
                <DestinationGroup
                  label={t("newSession.yourDevices")}
                  rows={devices()}
                  selectedKey={selectedKey()}
                  tabKey={tabKey()}
                  onSelect={select}
                  registerButton={registerButton}
                />
                <DestinationGroup
                  label={t("sessionsView.moveServerCloud")}
                  rows={servers()}
                  selectedKey={selectedKey()}
                  tabKey={tabKey()}
                  onSelect={select}
                  registerButton={registerButton}
                  renderConfig={options.allowMachineOverrides === false ? undefined : config}
                />
              </Loading>
            </Errored>
          </div>
          <p
            class={["session-move__notice", { "session-move__notice--warning": warning }]}
            role={warning ? "alert" : undefined}
          >
            {t(`sessionsView.${notice}`)}
          </p>
        </div>
      </div>
      <openclaw-modal-actions class="session-move__actions">
        <button type="button" class="btn" onClick={() => finish(null)}>
          {t("common.cancel")}
        </button>
        <button type="submit" class="btn primary" disabled={!selectable()}>
          {t(`sessionsView.${options.mode}SessionAction`)}
        </button>
      </openclaw-modal-actions>
    </form>
  );
}

function DestinationGroup(props: {
  label: string;
  rows: readonly Destination[];
  selectedKey: string;
  tabKey?: string;
  onSelect: (target: SessionMoveTarget) => void;
  registerButton: (key: string, button: HTMLButtonElement) => () => void;
  renderConfig?: (profile: DraftCloudProfile) => JSX.Element;
}) {
  const [expanded, expand] = createSignal(false);
  const [retained, retain] = createSignal("");
  const preview = createMemo(() => {
    const first = props.rows.slice(0, 4);
    const chosen = props.rows.find((row) => row.key === retained());
    return new Set(
      chosen && !first.includes(chosen)
        ? [...first.slice(0, 3), chosen].map((row) => row.key)
        : first.map((row) => row.key),
    );
  });
  let list!: HTMLDivElement;
  let animation: Animation | undefined;
  let motionRevision = 0;
  const prepare = (keyboard: boolean, restoreFocus?: HTMLButtonElement) => {
    const revision = ++motionRevision;
    const height = list.getBoundingClientRect().height;
    animation?.cancel();
    onSettled(() => {
      if (revision !== motionRevision || !list.isConnected) {
        return;
      }
      restoreFocus?.focus({ preventScroll: true });
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!keyboard) {
        animation = list.animate(
          reduced
            ? [{ opacity: 0.6 }, { opacity: 1 }]
            : [{ height: `${height}px` }, { height: `${list.scrollHeight}px` }],
          { duration: reduced ? 100 : 300, easing: "ease-in-out" },
        );
      }
    });
  };
  onSettled(() => () => animation?.cancel());
  return (
    <Show when={props.rows.length > 0}>
      <section class="session-move__group" aria-label={props.label}>
        <h3>{props.label}</h3>
        <div
          class="session-move__list"
          ref={(element) => {
            list = element;
          }}
        >
          <For each={props.rows} keyed={(row) => row.key}>
            {(row) => {
              const visible = () => expanded() || preview().has(row().key);
              const selected = () => props.selectedKey === row().key;
              const configuration = () => selected() && row().profile && props.renderConfig;
              return (
                <div
                  class={[
                    "session-move__entry",
                    { "is-selected": selected(), "has-configuration": Boolean(configuration()) },
                  ]}
                  hidden={!visible()}
                  inert={!visible()}
                >
                  <button
                    ref={[elementRef(props.registerButton.bind(undefined, row().key))]}
                    type="button"
                    role="radio"
                    aria-checked={selected() ? "true" : "false"}
                    aria-pressed={selected() ? "true" : "false"}
                    class="session-move__destination"
                    data-value={row().key}
                    tabindex={props.tabKey === row().key ? 0 : -1}
                    disabled={Boolean(row().disabledReason)}
                    title={row().disabledReason}
                    onClick={(event) => {
                      prepare(event.detail === 0, event.currentTarget);
                      props.onSelect(row().target);
                      retain(row().key);
                      expand(false);
                    }}
                  >
                    <span class="session-move__icon">
                      {row().profile ? (
                        <CloudProfileIcon profile={row().profile} />
                      ) : (
                        <Icon name={row().target.kind === "device" ? "monitor" : "server"} />
                      )}
                    </span>
                    <span class="session-move__identity">
                      <span class="session-move__name">{row().label}</span>
                      <Show when={row().subtitle}>
                        <span class="session-move__support">{row().subtitle}</span>
                      </Show>
                      <Show when={row().disabledReason || row().facts?.length}>
                        <span class="session-move__support">
                          {[row().disabledReason, ...(row().facts ?? [])]
                            .filter((fact, index, all) => fact && all.indexOf(fact) === index)
                            .join(" · ")}
                        </span>
                      </Show>
                    </span>
                    <Show when={row().profile}>
                      <span class="session-move__badge">
                        {resolveCloudProfileIconData(row().profile).label}
                      </span>
                    </Show>
                    <span class="session-move__radio" aria-hidden="true" />
                  </button>
                  <Show when={configuration()}>
                    {(renderConfig) => <>{renderConfig()(row().profile!)}</>}
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
        <Show when={props.rows.length > 4}>
          <button
            type="button"
            class="session-move__disclosure"
            aria-expanded={expanded() ? "true" : "false"}
            onClick={(event: MouseEvent) => {
              prepare(event.detail === 0);
              // A keyboard-selected deep destination remains visible when explicitly collapsed.
              if (expanded() && props.rows.some((row) => row.key === props.selectedKey)) {
                retain(props.selectedKey);
              }
              expand(!expanded());
            }}
          >
            {t(expanded() ? "sessionsView.moveShowLess" : "sessionsView.moveShowMore")}
            <Icon name={expanded() ? "chevronUp" : "chevronDown"} />
          </button>
        </Show>
      </section>
    </Show>
  );
}

function CloudConfiguration(props: {
  profile: DraftCloudProfile;
  profiles: readonly DraftCloudProfile[];
  machines: DraftCloudMachineState;
  revision: number;
  onChange: () => void;
}) {
  const groups = createMemo<
    {
      kind: "os" | "machine";
      label: string;
      choices: CloudChoiceMenuItemsOptions["choices"];
      selectedId: string;
    }[]
  >(() => {
    void props.revision;
    const selection = props.machines.selection(props.profile.id, props.profiles);
    return [
      {
        kind: "os" as const,
        label: t("newSession.operatingSystem"),
        choices: props.profile.operatingSystems ?? [],
        selectedId: selection.os,
      },
      {
        kind: "machine" as const,
        label: t("newSession.machine"),
        choices: props.machines.machines(props.profile),
        selectedId: selection.machineClass,
      },
    ];
  });
  return (
    <div class="session-move__configuration">
      <For each={groups()} keyed={(group) => group.kind}>
        {(group) => (
          <Show when={group().choices.length > (group().kind === "os" ? 1 : 0)}>
            <div class="session-move__config-row">
              <span>{group().label}</span>
              <Show
                when={group().choices.length > 1}
                fallback={
                  <span class="session-move__fixed-value">
                    {group().choices[0]?.label}
                    <Show when={group().kind === "machine" && group().choices[0]}>
                      {(machine) => (
                        <Show when={machineShapeText(machine())}>
                          {(shape) => <span class="session-move__shape">{shape()}</span>}
                        </Show>
                      )}
                    </Show>
                  </span>
                }
              >
                <Menu
                  id={`session-move-${props.profile.id}-${group().kind}`}
                  label={group().label}
                  placement="bottom-end"
                  class="session-move__config-menu"
                  triggerClass="session-move__config-trigger"
                  trigger={
                    <>
                      {group().choices.find((choice) => choice.id === group().selectedId)?.label ??
                        group().selectedId}
                      <Show
                        when={
                          group().kind === "machine" &&
                          group().choices.find((choice) => choice.id === group().selectedId)
                        }
                      >
                        {(machine) => (
                          <Show when={machineShapeText(machine())}>
                            {(shape) => <span class="session-move__shape">{shape()}</span>}
                          </Show>
                        )}
                      </Show>
                      <Icon name="chevronDown" />
                    </>
                  }
                  items={group().choices.map((choice) => ({
                    id: choice.id,
                    label: choice.label,
                    type: "radio" as const,
                    checked: choice.id === group().selectedId,
                    disabled: group().kind === "os" && Boolean(choice.disabledReason),
                    details:
                      group().kind === "machine" ? machineShapeText(choice) : choice.disabledReason,
                  }))}
                  onSelect={(item) => {
                    props.machines[group().kind === "os" ? "selectOs" : "select"](
                      props.profile.id,
                      item.id,
                      props.profiles,
                      false,
                      props.onChange,
                    );
                  }}
                />
              </Show>
            </div>
          </Show>
        )}
      </For>
    </div>
  );
}
