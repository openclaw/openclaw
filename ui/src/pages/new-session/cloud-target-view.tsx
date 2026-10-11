import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import type {
  WorkerMachineOption,
  WorkerOperatingSystem,
} from "../../../../packages/gateway-protocol/src/schema/environments.ts";
import {
  compareCloudProfiles,
  resolveCloudProfileIconData,
} from "../../components/provider-icon-data.ts";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import "../../components/tooltip.ts";
import { CloudProfileIcon } from "../../components/solid/provider-icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { LitContent } from "../../lit/solid-content.tsx";
import {
  machineShapeText,
  type SessionMenuItemOptions,
  type CloudProfileMenuItemsOptions,
  type CloudChoiceMenuItemsOptions,
} from "./cloud-target.ts";
import {
  cloudMachinesForOs,
  defaultCloudMachine,
  defaultCloudOs,
  type DraftCloudProfile,
} from "./discovery.ts";

type NativeSessionMenuItem = Omit<SessionMenuItemOptions, "icon"> & { icon?: JSX.Element };

function UnavailableReason(props: {
  reason: string;
  remediation: SessionMenuItemOptions["remediation"];
}) {
  return (
    <>
      {props.remediation === "enable-session-hosting" ? (
        <>
          <div>{t("newSession.sessionHostingAction")}</div>
          <code class="new-session-page__command">
            openclaw config set nodeHost.workerRuns.enabled true
          </code>
          <code class="new-session-page__command">openclaw node install --force</code>
        </>
      ) : props.remediation === "update-device" ? (
        <>
          <div>{t("newSession.updateAction")}</div>
          <code class="new-session-page__command">openclaw update</code>
          <div>{t("newSession.reconnectAction")}</div>
          <code class="new-session-page__command">openclaw node restart</code>
        </>
      ) : (
        props.reason
      )}
    </>
  );
}

function DetailRow(props: { icon: IconName; text: string | undefined; capacity?: boolean }) {
  return (
    <>
      {props.text ? (
        <div class="new-session-page__card-row">
          <span class="new-session-page__card-icon" aria-hidden="true">
            <Icon name={props.icon} />
          </span>
          <span class={props.capacity ? "new-session-page__capacity-caption" : undefined}>
            {props.text}
          </span>
        </div>
      ) : undefined}
    </>
  );
}

export function SessionMenuItem(props: { item: NativeSessionMenuItem; submitting: boolean }) {
  const unavailableReason = () =>
    props.item.disabled ? props.item.title || props.item.description : undefined;
  const description = () => (props.item.compact ? undefined : props.item.description);
  const accessibleBlocker = () =>
    props.item.compact && props.item.disabled && !props.item.hideDetails;
  const touchDetails = () => props.item.compact && !props.item.disabled && !props.item.hideDetails;
  const accessibilityHints = () =>
    [
      props.item.suggested ? t("newSession.machineDefault") : undefined,
      props.item.accessibleProvider
        ? t("newSession.cloudWorkerProvider", { provider: props.item.accessibleProvider })
        : undefined,
    ]
      .filter(Boolean)
      .join(", ");
  const accessibleDescription = () =>
    [accessibilityHints(), props.item.accessibleProvider ? unavailableReason() : undefined]
      .filter(Boolean)
      .join(", ");
  const select = nativeListener("click", (event) => {
    if (props.item.disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    props.item.onSelect();
  });
  const row = () => (
    <button
      type="button"
      class={[
        "session-menu__item",
        {
          "session-menu__item--described": Boolean(description()),
          "new-session-page__environment-option": props.item.compact,
        },
      ]}
      data-suggested={props.item.suggested ? "true" : undefined}
      aria-description={accessibleDescription() || undefined}
      data-value={props.item.value}
      data-popover={props.item.keepOpen || accessibleBlocker() ? undefined : "close"}
      aria-pressed={props.item.checked ? "true" : "false"}
      title={props.item.compact ? undefined : props.item.title}
      disabled={props.submitting || (Boolean(props.item.disabled) && !accessibleBlocker())}
      aria-disabled={accessibleBlocker() ? "true" : undefined}
      ref={select}
    >
      {props.item.icon ? (
        <span class="session-menu__icon" aria-hidden="true">
          {props.item.icon}
        </span>
      ) : undefined}
      <span class="session-menu__text">
        {props.item.label}{" "}
        {props.item.selectedSummary ? (
          <span class="new-session-page__selected-summary">{props.item.selectedSummary}</span>
        ) : undefined}
        {description() ? <span class="session-menu__description">{description()}</span> : undefined}
      </span>
      {!props.item.compact && props.item.facts?.length ? (
        <span class="new-session-page__menu-meta">
          <span class="new-session-page__menu-facts">
            <For each={props.item.facts}>
              {(fact) => <span class="new-session-page__menu-fact">{fact}</span>}
            </For>
          </span>
        </span>
      ) : undefined}
      {!props.item.compact && props.item.sub ? (
        <span class="session-menu__sub">{props.item.sub}</span>
      ) : undefined}
      <span class="session-menu__check" aria-hidden="true">
        {props.item.checked ? <Icon name="check" /> : undefined}
      </span>
      {props.item.hasSubmenu ? (
        <span class="new-session-page__submenu-chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      ) : undefined}
    </button>
  );
  return (
    <>
      {props.item.compact && !props.item.hideDetails ? (
        <openclaw-tooltip
          class="new-session-page__environment-details"
          placement="right-start"
          prop:openOnClick={Boolean(accessibleBlocker() || touchDetails())}
        >
          <div class="new-session-page__environment-detail-trigger">
            {row()}
            {touchDetails() ? (
              <button
                type="button"
                class="new-session-page__touch-details"
                aria-label={t("newSession.environmentDetails", { name: props.item.label })}
                disabled={props.submitting}
              >
                <Icon name="info" />
              </button>
            ) : undefined}
          </div>
          <div slot="content" class="new-session-page__environment-card">
            {accessibilityHints() ? <span hidden>{accessibilityHints()}, </span> : undefined}
            {unavailableReason() ? (
              <span>
                <UnavailableReason
                  reason={unavailableReason()!}
                  remediation={props.item.remediation}
                />
              </span>
            ) : (
              <>
                <strong>{props.item.label}</strong>{" "}
                <DetailRow icon="info" text={props.item.summary} />
                <DetailRow icon="layers" text={props.item.platform} />
                <DetailRow icon="info" text={props.item.sub} />
                <DetailRow icon="info" text={props.item.capabilityLabels?.join(", ")} />
                <DetailRow
                  icon={props.item.trust === "persistent" ? "repeat" : "clock"}
                  text={
                    props.item.trust
                      ? t(
                          props.item.trust === "persistent"
                            ? "newSession.persistentEnvironmentHint"
                            : "newSession.disposableEnvironmentHint",
                        )
                      : undefined
                  }
                />
                <DetailRow icon="server" text={props.item.provider} />
                <DetailRow icon="info" text={props.item.hardware} />
                <For
                  each={[
                    ...new Set(
                      [
                        props.item.description,
                        ...(props.item.facts ?? []),
                        props.item.provider && !props.item.disabled ? undefined : props.item.title,
                      ].filter(Boolean),
                    ),
                  ]}
                >
                  {(detail) => <DetailRow icon="info" text={detail} />}
                </For>
                <DetailRow icon="activity" text={props.item.capacityLabel} capacity />
              </>
            )}
          </div>
        </openclaw-tooltip>
      ) : (
        row()
      )}
    </>
  );
}

export function LegacySessionMenuItem(props: {
  item: SessionMenuItemOptions;
  submitting: boolean;
}) {
  return (
    <SessionMenuItem
      item={{
        ...props.item,
        icon: props.item.icon ? <LitContent value={props.item.icon} /> : undefined,
      }}
      submitting={props.submitting}
    />
  );
}

export function CloudProfileMenuItems(props: { params: CloudProfileMenuItemsOptions }) {
  return (
    <>
      <For
        each={props.params.profiles.toSorted(compareCloudProfiles)}
        keyed={(profile) => profile.id}
      >
        {(profile) => <CloudProfileMenuItem profile={profile()} params={props.params} />}
      </For>
    </>
  );
}

function CloudProfileMenuItem(props: {
  profile: DraftCloudProfile;
  params: CloudProfileMenuItemsOptions;
}) {
  const selected = () => props.params.selectedId === props.profile.id;
  const osId = () =>
    (selected() ? props.params.selectedOs : undefined) || defaultCloudOs(props.profile);
  const os = () => props.profile.operatingSystems?.find((option) => option.id === osId());
  const machines = () => cloudMachinesForOs(props.profile, osId());
  const machine = () =>
    (selected() && props.params.selectedMachine
      ? machines().find((option) => option.id === props.params.selectedMachine)
      : undefined) ?? defaultCloudMachine(props.profile, osId());
  const disabledReason = () => props.params.profileDisabledReason?.(props.profile);
  const presentation = () => resolveCloudProfileIconData(props.profile);
  const hasSubmenu = () =>
    Boolean(
      props.params.compact &&
      !props.params.disabled &&
      !disabledReason() &&
      ((props.profile.operatingSystems?.some((option) => !option.disabledReason) ?? false) ||
        machines().length > 0),
    );
  const item = () => (
    <SessionMenuItem
      submitting={props.params.submitting}
      item={{
        value: `cloud:${props.profile.id}`,
        label: props.params.compact
          ? props.profile.id
          : t("newSession.cloudWorker", { profile: props.profile.id }),
        hasSubmenu: hasSubmenu(),
        selectedSummary:
          props.params.compact && selected()
            ? [
                os()?.label,
                machine()?.label,
                props.profile.inference === "worker"
                  ? t("sessionsView.inferenceWorker")
                  : undefined,
              ]
                .filter(Boolean)
                .join(" · ")
            : undefined,
        description:
          props.profile.inference === "worker" ? t("sessionsView.inferenceWorker") : undefined,
        icon: <CloudProfileIcon profile={props.profile} />,
        accessibleProvider: presentation().label,
        compact: props.params.compact,
        facts:
          !props.params.compact && props.profile.trust === "disposable"
            ? [t("newSession.environmentDisposable")]
            : !props.params.compact && props.profile.trust === "persistent"
              ? [t("newSession.environmentPersistent")]
              : undefined,
        trust: props.params.compact ? props.profile.trust : undefined,
        provider: props.params.compact ? presentation().label : undefined,
        platform: props.params.compact ? os()?.label : undefined,
        hardware: props.params.compact && machine() ? machineShapeText(machine()!) : undefined,
        hideDetails: Boolean(props.params.compact && !props.params.disabled && !disabledReason()),
        keepOpen: props.params.compact,
        checked: selected(),
        disabled: props.params.disabled || Boolean(disabledReason()),
        title:
          (props.params.disabled ? props.params.disabledReason : disabledReason()) ??
          t("newSession.cloudWorkerProvider", { provider: presentation().label }),
        onSelect: () =>
          props.params.compact && !selected()
            ? props.params.onSelect(props.profile.id, true)
            : props.params.onSelect(props.profile.id),
      }}
    />
  );
  return (
    <>
      {hasSubmenu() ? (
        <openclaw-tooltip
          class="new-session-page__environment-details new-session-page__cloud-config-card"
          placement="right"
          prop:openOnClick={true}
        >
          {item()}
          <div slot="content">
            <span hidden>
              {t("newSession.cloudWorkerProvider", { provider: presentation().label })}
            </span>
            <CloudConfiguration
              profile={props.profile}
              operatingSystems={props.profile.operatingSystems ?? []}
              machines={machines()}
              suggested={!selected()}
              selectedOs={selected() ? osId() : ""}
              selectedMachine={selected() ? (machine()?.id ?? "") : ""}
              submitting={props.params.submitting}
              onSelectOs={(id) => {
                if (!selected()) {
                  props.params.onSelect(props.profile.id, true);
                }
                props.params.onSelectOs?.(id);
              }}
              onSelectMachine={(id) => {
                if (!selected()) {
                  props.params.onSelect(props.profile.id, true);
                }
                props.params.onSelectMachine?.(id);
              }}
            />
          </div>
        </openclaw-tooltip>
      ) : (
        item()
      )}
    </>
  );
}

function CloudConfiguration(props: {
  profile: DraftCloudProfile;
  suggested: boolean;
  operatingSystems: readonly WorkerOperatingSystem[];
  machines: readonly WorkerMachineOption[];
  selectedOs: string;
  selectedMachine: string;
  submitting: boolean;
  onSelectOs: (id: string) => void;
  onSelectMachine: (id: string) => void;
}) {
  const groups = () =>
    [
      {
        kind: "os",
        label: t("newSession.operatingSystem"),
        choices: props.operatingSystems.filter((os) => !os.disabledReason),
        selectedId: props.selectedOs,
        suggestedId: props.suggested ? defaultCloudOs(props.profile) : undefined,
        onSelect: props.onSelectOs,
      },
      {
        kind: "machine",
        label: t("newSession.machine"),
        choices: props.machines,
        selectedId: props.selectedMachine,
        suggestedId: props.suggested
          ? defaultCloudMachine(props.profile, props.selectedOs)?.id
          : undefined,
        onSelect: props.onSelectMachine,
      },
    ] as const;
  return (
    <section class="new-session-page__cloud-configuration" aria-label={props.profile.id}>
      <For each={groups()} keyed={(group) => group.kind}>
        {(group) => (
          <>
            {group().choices.length ? (
              <>
                <div class="new-session-page__environment-heading">{group().label}</div>
                <div
                  class="new-session-page__cloud-choice-list"
                  role="group"
                  aria-label={group().label}
                >
                  {group().choices.length === 1 ? (
                    group().kind === "machine" ? (
                      <span
                        class="new-session-page__fixed-machine"
                        data-value={`machine:${group().choices[0]!.id}`}
                      >
                        <span>{group().choices[0]!.label}</span>
                        {machineShapeText(group().choices[0]!) ? (
                          <span>{machineShapeText(group().choices[0]!)}</span>
                        ) : undefined}
                      </span>
                    ) : (
                      <span
                        class="new-session-page__fixed-os"
                        data-value={`os:${group().choices[0]!.id}`}
                      >
                        {group().choices[0]!.label}
                      </span>
                    )
                  ) : (
                    <CloudChoiceMenuItems params={{ ...group(), submitting: props.submitting }} />
                  )}
                </div>
              </>
            ) : undefined}
          </>
        )}
      </For>
    </section>
  );
}

export function CloudChoiceMenuItems(props: { params: CloudChoiceMenuItemsOptions }) {
  return (
    <>
      <For each={props.params.choices} keyed={(choice) => choice.id}>
        {(choice) => (
          <SessionMenuItem
            submitting={props.params.submitting}
            item={{
              suggested: props.params.suggestedId === choice().id,
              value: `${props.params.kind}:${choice().id}`,
              label: choice().label,
              ...(props.params.kind === "machine"
                ? { sub: machineShapeText(choice()) }
                : {
                    description: choice().disabledReason,
                    disabled: Boolean(choice().disabledReason),
                    title: choice().disabledReason,
                  }),
              checked:
                props.params.selectedId === choice().id ||
                (!props.params.selectedId && props.params.suggestedId === choice().id),
              keepOpen: true,
              onSelect: () => props.params.onSelect(choice().id),
            }}
          />
        )}
      </For>
    </>
  );
}
