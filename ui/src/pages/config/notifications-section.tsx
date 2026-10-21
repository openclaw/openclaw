import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type {
  WebPushDevicePreferences,
  WebPushNotificationPreferences,
} from "../../../../packages/gateway-protocol/src/schema/push.js";
import type { NativeNotificationsPermission } from "../../app/native-notifications.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsPage,
  SettingsRow,
  SettingsStatus,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { resolveTimezoneSuggestions } from "../../lib/timezone-suggestions.ts";
import { SettingsSectionHeader } from "./settings-section-header.tsx";
import { SettingsSelectRow } from "./settings-select-row.tsx";
import { COMMUNICATION_SETTINGS_TARGET_IDS } from "./settings-targets.ts";
import type { ConfigProps } from "./view-types.ts";

registerEnglishCatalog(registerSettingsEnglish);

export type NotificationsSectionProps = Pick<
  ConfigProps,
  | "connected"
  | "nativeNotifications"
  | "onNativeNotificationsRequestPermission"
  | "onNativeNotificationsSendTest"
  | "webPush"
  | "onWebPushSubscribe"
  | "onWebPushUnsubscribe"
  | "onWebPushTest"
  | "onWebPushSetUserPreferences"
  | "onWebPushSetDevicePreferences"
>;

const WEB_PUSH_CATEGORIES = [
  "approvalRequested",
  "agentFinished",
  "agentQuestion",
  "humanMentioned",
  "scheduledTaskFailed",
] as const;

function minutesToTime(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function timeToMinutes(value: string, fallback: number): number {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
}

type DetailLevel = WebPushNotificationPreferences["detailLevel"];
function detailLevel(value: string): DetailLevel {
  return value === "identified" || value === "detailed" ? value : "private";
}

type InheritChoice = "inherit" | "on" | "off";
type QuietHoursWindow = WebPushNotificationPreferences["quietHours"];
function detailLevelOptions(): Array<{ value: DetailLevel; label: string }> {
  return [
    { value: "private", label: t("configView.notifications.private") },
    { value: "identified", label: t("configView.notifications.namesOnly") },
    { value: "detailed", label: t("configView.notifications.detailed") },
  ];
}
function inheritChoiceOptions(
  inheritLabel: string,
): Array<{ value: InheritChoice; label: string }> {
  return [
    { value: "inherit", label: inheritLabel },
    { value: "on", label: t("configForm.enumOn") },
    { value: "off", label: t("configForm.enumOff") },
  ];
}

function QuietHoursWindowRows(props: {
  quietHours: QuietHoursWindow;
  disabled?: boolean;
  onChange: (value: QuietHoursWindow) => void;
}) {
  return (
    <div class="settings-subrows quiet-hours-window">
      <SettingsRow
        title={t("configView.notifications.quietHoursWindow")}
        control={
          <For
            each={
              [
                ["startMinute", "quietHoursStart"],
                ["endMinute", "quietHoursEnd"],
              ] as const
            }
            keyed={(entry) => entry[0]}
          >
            {(entry, index) => (
              <>
                {index() > 0 && (
                  <span class="settings-row__value" aria-hidden="true">
                    –
                  </span>
                )}
                <input
                  disabled={props.disabled}
                  type="time"
                  class="settings-input"
                  aria-label={t(`configView.notifications.${entry()[1]}`)}
                  value={minutesToTime(props.quietHours[entry()[0]])}
                  onChange={(event) =>
                    props.onChange({
                      ...props.quietHours,
                      [entry()[0]]: timeToMinutes(
                        event.currentTarget.value,
                        props.quietHours[entry()[0]],
                      ),
                    })
                  }
                />
              </>
            )}
          </For>
        }
      />
      <SettingsSelectRow
        disabled={props.disabled}
        title={t("configView.notifications.timeZone")}
        value={props.quietHours.timeZone}
        options={resolveTimezoneSuggestions([props.quietHours.timeZone]).map((value) => ({
          value,
          label: value.replaceAll("_", " "),
        }))}
        onChange={(timeZone) => props.onChange({ ...props.quietHours, timeZone })}
      />
    </div>
  );
}

function AgentIdsRow(props: {
  agentIds: string[];
  disabled?: boolean;
  onChange: (value: string[]) => void;
}) {
  return (
    <SettingsRow
      title={t("configView.notifications.onlyAgents")}
      control={
        <input
          disabled={props.disabled}
          type="text"
          class="settings-input"
          aria-label={t("configView.notifications.onlyAgents")}
          value={props.agentIds.join(", ")}
          onChange={(event) =>
            props.onChange(
              event.currentTarget.value
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean),
            )
          }
        />
      }
    />
  );
}

function UserNotificationPreferences(props: {
  preferences: WebPushNotificationPreferences;
  disabled?: boolean;
  onChange: (value: WebPushNotificationPreferences) => void;
}) {
  const patch = (next: Partial<WebPushNotificationPreferences>) =>
    props.onChange({ ...props.preferences, ...next });
  return (
    <section class="settings-section">
      <SettingsSectionHeader title={t("configView.notifications.accountDefaults")} />
      <div class="settings-group">
        <For each={WEB_PUSH_CATEGORIES}>
          {(entry) => (
            <SettingsToggleRow
              disabled={props.disabled}
              title={t(`configView.notifications.${entry}`)}
              checked={props.preferences.categories[entry] === true}
              onChange={(checked) =>
                patch({ categories: { ...props.preferences.categories, [entry]: checked } })
              }
            />
          )}
        </For>
        <SettingsSelectRow
          disabled={props.disabled}
          title={t("configView.notifications.lockScreenDetail")}
          description={t("configView.notifications.lockScreenDetailHint")}
          value={props.preferences.detailLevel}
          options={detailLevelOptions()}
          onChange={(value) => patch({ detailLevel: detailLevel(value) })}
        />
        <SettingsToggleRow
          disabled={props.disabled}
          title={t("configView.notifications.quietHours")}
          checked={props.preferences.quietHours.enabled}
          onChange={(enabled) =>
            patch({ quietHours: { ...props.preferences.quietHours, enabled } })
          }
        />
        <Show when={props.preferences.quietHours.enabled}>
          <QuietHoursWindowRows
            disabled={props.disabled}
            quietHours={props.preferences.quietHours}
            onChange={(quietHours) => patch({ quietHours })}
          />
        </Show>
        <AgentIdsRow
          disabled={props.disabled}
          agentIds={props.preferences.agentIds}
          onChange={(agentIds) => patch({ agentIds })}
        />
      </div>
    </section>
  );
}

function DeviceNotificationPreferences(props: {
  preferences: WebPushDevicePreferences;
  disabled?: boolean;
  onChange: (value: WebPushDevicePreferences) => void;
}) {
  const patch = (next: Partial<WebPushDevicePreferences>) =>
    props.onChange({ ...props.preferences, ...next });
  return (
    <section class="settings-section">
      <SettingsSectionHeader title={t("configView.notifications.installedApp")} />
      <div class="settings-group">
        <SettingsToggleRow
          disabled={props.disabled}
          title={t("configView.notifications.deliverDevice")}
          checked={props.preferences.enabled}
          onChange={(enabled) => patch({ enabled })}
        />
        <SettingsRow
          title={t("configView.notifications.notificationLabel")}
          control={
            <input
              disabled={props.disabled}
              type="text"
              class="settings-input"
              aria-label={t("configView.notifications.notificationLabel")}
              maxlength={80}
              value={props.preferences.label}
              onChange={(event) => patch({ label: event.currentTarget.value })}
            />
          }
        />
        <SettingsSelectRow
          disabled={props.disabled}
          title={t("configView.notifications.lockScreenDetail")}
          value={props.preferences.detailLevel ?? "inherit"}
          options={[
            { value: "inherit", label: t("configView.notifications.inheritDetail") },
            ...detailLevelOptions(),
          ]}
          onChange={(value) =>
            patch({ detailLevel: value === "inherit" ? undefined : detailLevel(value) })
          }
        />
        <SettingsSelectRow
          disabled={props.disabled}
          title={t("configView.notifications.quietHours")}
          value={
            props.preferences.quietHours === undefined
              ? "inherit"
              : props.preferences.quietHours.enabled
                ? "on"
                : "off"
          }
          options={inheritChoiceOptions(t("configView.notifications.inheritQuietHours"))}
          onChange={(value) =>
            patch({
              quietHours:
                value === "inherit"
                  ? undefined
                  : {
                      enabled: value === "on",
                      startMinute: props.preferences.quietHours?.startMinute ?? 22 * 60,
                      endMinute: props.preferences.quietHours?.endMinute ?? 7 * 60,
                      timeZone: props.preferences.quietHours?.timeZone ?? "UTC",
                    },
            })
          }
        />
        <Show
          when={props.preferences.quietHours?.enabled ? props.preferences.quietHours : undefined}
        >
          {(quietHours) => (
            <QuietHoursWindowRows
              disabled={props.disabled}
              quietHours={quietHours()}
              onChange={(value) => patch({ quietHours: value })}
            />
          )}
        </Show>
        <SettingsSelectRow
          disabled={props.disabled}
          title={t("configView.notifications.onlyAgents")}
          value={props.preferences.agentIds === undefined ? "inherit" : "override"}
          options={[
            { value: "inherit", label: t("configView.notifications.inherit") },
            { value: "override", label: t("configView.notifications.overrideAgents") },
          ]}
          onChange={(value) => patch({ agentIds: value === "inherit" ? undefined : [] })}
        />
        <Show when={props.preferences.agentIds}>
          {(agentIds) => (
            <AgentIdsRow
              disabled={props.disabled}
              agentIds={agentIds()}
              onChange={(value) => patch({ agentIds: value })}
            />
          )}
        </Show>
        <For each={WEB_PUSH_CATEGORIES}>
          {(entry) => (
            <SettingsSelectRow
              disabled={props.disabled}
              title={t(`configView.notifications.${entry}`)}
              value={
                props.preferences.categories?.[entry] === undefined
                  ? "inherit"
                  : props.preferences.categories?.[entry]
                    ? "on"
                    : "off"
              }
              options={inheritChoiceOptions(t("configView.notifications.inherit"))}
              onChange={(value) => {
                const categories = { ...props.preferences.categories };
                if (value === "inherit") {
                  delete categories[entry];
                } else {
                  categories[entry] = value === "on";
                }
                patch({ categories });
              }}
            />
          )}
        </For>
      </div>
    </section>
  );
}

function nativeNotificationsStatus(permission: NativeNotificationsPermission | "unknown"): {
  kind: "ok" | "danger" | "accent" | "muted";
  label: string;
} {
  switch (permission) {
    case "granted":
      return { kind: "ok", label: t("configView.notifications.granted") };
    case "denied":
      return { kind: "danger", label: t("configView.notifications.denied") };
    case "notDetermined":
      return { kind: "accent", label: t("configView.notifications.notRequested") };
    default:
      return { kind: "muted", label: t("configView.notifications.checking") };
  }
}

function NotificationActions(props: { children: JSX.Element }) {
  return (
    <div class="settings-row">
      <div class="settings-row__control">{props.children}</div>
    </div>
  );
}
function BlockedNotifications(props: { description: string }) {
  return (
    <SettingsRow
      title={t("configView.notifications.blocked")}
      description={props.description}
      control={<SettingsStatus kind="danger" label={t("configView.notifications.denied")} />}
    />
  );
}
function NotificationSection(props: {
  title: string;
  status: JSX.Element;
  description?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <section class="settings-section" id={COMMUNICATION_SETTINGS_TARGET_IDS.notifications}>
      <div class="settings-section__header">
        <h2 class="settings-section__heading">{props.title}</h2>
        <div class="settings-section__actions">{props.status}</div>
      </div>
      {props.description}
      <div class="settings-group">{props.children}</div>
    </section>
  );
}

function NativeNotificationSection(props: {
  native: NonNullable<NotificationsSectionProps["nativeNotifications"]>;
  actions: NotificationsSectionProps;
}) {
  const status = () => nativeNotificationsStatus(props.native.permission);
  const testPending = () => props.native.test?.state === "pending";
  const testDescription = () => {
    const test = props.native.test;
    return test?.state === "error" ? test.message : undefined;
  };
  return (
    <NotificationSection
      title={t("configView.notifications.nativeTitle")}
      status={<SettingsStatus kind={status().kind} label={status().label} />}
    >
      <SettingsRow
        title={t("configView.notifications.permission")}
        control={<SettingsValue value={status().label} />}
      />
      <Show
        when={
          props.native.permission === "notDetermined" ||
          props.native.permission === "denied" ||
          props.native.permission === "granted"
        }
      >
        <NotificationActions>
          {props.native.permission === "granted" ? (
            <button
              class="btn primary"
              disabled={testPending()}
              onClick={() => props.actions.onNativeNotificationsSendTest?.()}
            >
              <Icon name={testPending() ? "loader" : "send"} />
              {testPending()
                ? t("configView.notifications.sendingTest")
                : t("configView.notifications.sendTest")}
            </button>
          ) : (
            <button
              class={["btn", { primary: props.native.permission === "notDetermined" }]}
              onClick={() => props.actions.onNativeNotificationsRequestPermission?.()}
            >
              {t(
                props.native.permission === "notDetermined"
                  ? "configView.notifications.enable"
                  : "configView.notifications.openSystemSettings",
              )}
            </button>
          )}
        </NotificationActions>
      </Show>
      <Show when={props.native.permission === "denied"}>
        <BlockedNotifications description={t("configView.notifications.nativeBlockedHint")} />
      </Show>
      <Show when={props.native.test}>
        {(test) => (
          <SettingsRow
            title={t("configView.notifications.testOutcome")}
            description={testDescription()}
            control={
              <SettingsStatus
                kind={testPending() ? "accent" : test().state === "sent" ? "ok" : "danger"}
                label={t(
                  testPending()
                    ? "configView.notifications.sendingTest"
                    : test().state === "sent"
                      ? "configView.notifications.testQueued"
                      : "configView.notifications.testFailed",
                )}
              />
            }
          />
        )}
      </Show>
    </NotificationSection>
  );
}

function WebPushSection(props: {
  push: NonNullable<NotificationsSectionProps["webPush"]>;
  actions: NotificationsSectionProps;
}) {
  const registered = () => props.push.subscription === "registered";
  const hasSubscription = () =>
    registered() ||
    props.push.subscription === "vapid-mismatch" ||
    props.push.subscription === "local";
  const permissionLabel = () =>
    t(
      props.push.permission === "granted"
        ? "configView.notifications.granted"
        : props.push.permission === "denied"
          ? "configView.notifications.denied"
          : props.push.permission === "default"
            ? "configView.notifications.notRequested"
            : "configView.notifications.unsupported",
    );
  const subscriptionLabel = () =>
    t(
      registered()
        ? "configView.notifications.subscribed"
        : props.push.subscription === "unknown"
          ? "configView.notifications.checking"
          : props.push.subscription === "local"
            ? "configView.notifications.localSubscription"
            : "configView.notifications.notSubscribed",
    );
  const statusLabel = () =>
    t(
      !props.push.supported
        ? "configView.notifications.unsupported"
        : !props.push.canManage
          ? "configView.notifications.unavailable"
          : props.push.permission === "denied"
            ? "configView.notifications.blocked"
            : registered()
              ? "configView.notifications.subscribed"
              : props.push.subscription === "vapid-mismatch"
                ? "configView.notifications.unavailable"
                : props.push.subscription === "unknown"
                  ? "configView.notifications.checking"
                  : "configView.notifications.ready",
    );
  const statusKind = () =>
    !props.push.supported || !props.push.canManage
      ? "muted"
      : props.push.permission === "denied" || props.push.subscription === "vapid-mismatch"
        ? "danger"
        : registered()
          ? "ok"
          : "accent";
  return (
    <>
      <NotificationSection
        title={t("configView.notifications.title")}
        status={<SettingsStatus kind={statusKind()} label={statusLabel()} />}
        description={
          props.push.permission === "install-required" ? (
            <p class="settings-section__desc">{t("configView.notifications.iosInstallRequired")}</p>
          ) : undefined
        }
      >
        <SettingsRow
          title={t("configView.notifications.browserSupport")}
          control={
            <SettingsValue
              value={t(
                props.push.supported
                  ? "configView.notifications.available"
                  : "configView.notifications.notSupported",
              )}
            />
          }
        />
        <SettingsRow
          title={t("configView.notifications.permission")}
          control={<SettingsValue value={permissionLabel()} />}
        />
        <SettingsRow
          title={t("configView.notifications.status")}
          control={
            <SettingsStatus kind={registered() ? "ok" : "muted"} label={subscriptionLabel()} />
          }
        />
        <Show when={props.push.supported && !props.push.canManage}>
          <SettingsRow
            title={t("configView.notifications.gatewayAccess")}
            description={t(
              props.actions.connected
                ? "configView.notifications.gatewayAccessRequired"
                : "configView.notifications.gatewayDisconnected",
            )}
            control={
              <SettingsStatus kind="muted" label={t("configView.notifications.unavailable")} />
            }
          />
        </Show>
        <Show
          when={
            props.push.supported &&
            props.push.permission !== "denied" &&
            (props.push.canManage || hasSubscription())
          }
        >
          <NotificationActions>
            {hasSubscription() ? (
              <>
                <button
                  class="btn"
                  disabled={props.push.loading || !props.actions.connected}
                  onClick={() => props.actions.onWebPushUnsubscribe?.()}
                >
                  <Icon name="x" /> {t("configView.notifications.unsubscribe")}
                </button>
                <Show when={registered() && props.push.canManage}>
                  <button
                    class="btn primary"
                    disabled={props.push.loading || !props.actions.connected}
                    onClick={() => props.actions.onWebPushTest?.()}
                  >
                    <Icon name="send" /> {t("configView.notifications.sendTest")}
                  </button>
                </Show>
              </>
            ) : (
              <Show when={props.push.canManage}>
                <button
                  class="btn primary"
                  disabled={props.push.loading || !props.actions.connected}
                  onClick={() => props.actions.onWebPushSubscribe?.()}
                >
                  <Show when={props.push.loading}>
                    <Icon name="loader" />
                  </Show>
                  {t(
                    props.push.loading
                      ? "configView.notifications.subscribing"
                      : "configView.notifications.enable",
                  )}
                </button>
              </Show>
            )}
          </NotificationActions>
        </Show>
        <Show when={props.push.permission === "denied"}>
          <BlockedNotifications description={t("configView.notifications.blockedHint")} />
        </Show>
        <Show when={props.push.error}>
          <div class="settings-row">
            <div class="settings-row__text">
              <span class="cfg-field__error">{formatUiExternalText(props.push.error)}</span>
            </div>
          </div>
        </Show>
      </NotificationSection>
      <Show when={props.push.canReadPreferences ? props.push.preferences : undefined}>
        {(preferences) => (
          <div class="settings-stack" inert={props.push.loading}>
            <Show when={preferences().durableIdentity}>
              <UserNotificationPreferences
                disabled={!props.push.canManage || !props.actions.connected}
                preferences={preferences().user}
                onChange={(value) => props.actions.onWebPushSetUserPreferences?.(value)}
              />
            </Show>
            <DeviceNotificationPreferences
              disabled={!props.push.canManage || !props.actions.connected}
              preferences={preferences().device}
              onChange={(value) => props.actions.onWebPushSetDevicePreferences?.(value)}
            />
          </div>
        )}
      </Show>
    </>
  );
}

export function NotificationsSection(props: NotificationsSectionProps) {
  return (
    <SettingsPage>
      <Show
        when={props.nativeNotifications}
        fallback={
          <Show
            when={props.webPush}
            fallback={
              <NotificationSection
                title={t("configView.notifications.title")}
                status={
                  <SettingsStatus kind="muted" label={t("configView.notifications.unavailable")} />
                }
              >
                <div class="settings-row">
                  <div class="settings-row__text">
                    <span class="settings-row__desc">
                      {t("configView.notifications.unavailableHint")}
                    </span>
                  </div>
                </div>
              </NotificationSection>
            }
          >
            {(push) => <WebPushSection push={push()} actions={props} />}
          </Show>
        }
      >
        {(native) => <NativeNotificationSection native={native()} actions={props} />}
      </Show>
    </SettingsPage>
  );
}
