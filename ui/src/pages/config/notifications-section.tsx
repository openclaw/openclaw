import type { JSX } from "@solidjs/web";
import {
  action,
  createMemo,
  createOptimistic,
  Errored,
  isPending,
  latest,
  Loading,
  onSettled,
  refresh,
  Show,
} from "solid-js";
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
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError, formatUiExternalText, UserFacingError } from "../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { COMMUNICATION_SETTINGS_TARGET_IDS } from "./settings-targets.ts";
import type { ConfigProps } from "./view-types.ts";
import {
  DeviceNotificationPreferences,
  UserNotificationPreferences,
} from "./web-push-preferences.tsx";

registerEnglishCatalog(registerSettingsEnglish);

export type NotificationsSectionProps = Pick<
  ConfigProps,
  | "connected"
  | "presentationRetired"
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

const NativeTestStatus = (props: { state: "pending" | "sent" | "error"; message?: string }) => (
  <SettingsRow
    title={t("configView.notifications.testOutcome")}
    description={props.message}
    control={
      <SettingsStatus
        kind={props.state === "pending" ? "accent" : props.state === "sent" ? "ok" : "danger"}
        label={t(
          props.state === "pending"
            ? "configView.notifications.sendingTest"
            : props.state === "sent"
              ? "configView.notifications.testQueued"
              : "configView.notifications.testFailed",
        )}
      />
    }
  />
);

function NativeNotificationSection(props: {
  native: NonNullable<NotificationsSectionProps["nativeNotifications"]>;
  actions: NotificationsSectionProps;
}) {
  const status = () => nativeNotificationsStatus(props.native.permission);
  const [sending, setSending] = createOptimistic(false);
  const testPending = () => sending() || props.native.test?.state === "pending";
  const presentTest = action(function* (pending: Promise<unknown> | void, retired: Promise<void>) {
    if (retired === props.actions.presentationRetired()) {
      setSending(true);
    }
    yield Promise.race([pending, retired]);
  });
  const sendTest = async () => {
    const retired = props.actions.presentationRetired();
    const pending = props.actions.onNativeNotificationsSendTest?.();
    // Let the synchronous owner's pending outcome publish before joining its transition.
    await Promise.resolve();
    return presentTest(pending, retired);
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
            <button class="btn primary" disabled={testPending()} onClick={() => void sendTest()}>
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
      <Show
        when={testPending()}
        fallback={
          <Show when={props.native.test} keyed>
            {(test) => {
              // A new attempt retires the old error region without replacing the send control.
              const outcome = createMemo(() => {
                if (test.state === "error") {
                  throw new UserFacingError(test.message);
                }
                return test.state;
              });
              return (
                <Errored
                  fallback={(error) => (
                    <NativeTestStatus state="error" message={formatUiError(error())} />
                  )}
                >
                  <NativeTestStatus state={outcome()} />
                </Errored>
              );
            }}
          </Show>
        }
      >
        <NativeTestStatus state="pending" />
      </Show>
    </NotificationSection>
  );
}

const renderWebPushError = (error: () => unknown) => (
  <div class="settings-row">
    <div class="settings-row__text">
      <span class="cfg-field__error">{formatUiError(error())}</span>
    </div>
  </div>
);

function WebPushSection(props: {
  push: NonNullable<NotificationsSectionProps["webPush"]>;
  actions: NotificationsSectionProps;
}) {
  const read = createMemo(() => props.push.read);
  const authoritativePreferences = createMemo(() => {
    read();
    return props.push.preferences;
  });
  const [preferences, setPreferences] = createOptimistic(() => authoritativePreferences());
  const [saving, setSaving] = createOptimistic(false, { equals: false });
  const commandOutcome = createMemo(() => props.push.command);
  const present = action(function* (
    completion: Promise<void>,
    edit?:
      | { scope: "user"; value: WebPushNotificationPreferences }
      | { scope: "device"; value: WebPushDevicePreferences },
  ) {
    setSaving(true);
    if (edit) {
      setPreferences((previous) =>
        previous ? { ...previous, [edit.scope]: edit.value } : previous,
      );
    }
    yield completion;
    void refresh(authoritativePreferences);
  });
  const submit = (
    completion: Promise<void> | undefined,
    edit?:
      | { scope: "user"; value: WebPushNotificationPreferences }
      | { scope: "device"; value: WebPushDevicePreferences },
  ) => {
    // Admission, including a browser permission prompt, stays in the event tick.
    if (completion) {
      onSettled(() => {
        void present(completion, edit).catch(() => {});
      });
    }
  };
  const busy = () => saving() || props.push.loading;
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
                  disabled={busy() || !props.actions.connected}
                  onClick={() => submit(props.actions.onWebPushUnsubscribe?.())}
                >
                  <Icon name="x" /> {t("configView.notifications.unsubscribe")}
                </button>
                <Show when={registered() && props.push.canManage}>
                  <button
                    class="btn primary"
                    disabled={busy() || !props.actions.connected}
                    onClick={() => submit(props.actions.onWebPushTest?.())}
                  >
                    <Icon name="send" /> {t("configView.notifications.sendTest")}
                  </button>
                </Show>
              </>
            ) : (
              <Show when={props.push.canManage}>
                <button
                  class="btn primary"
                  disabled={busy() || !props.actions.connected}
                  onClick={() => submit(props.actions.onWebPushSubscribe?.())}
                >
                  <Show when={busy()}>
                    <Icon name="loader" />
                  </Show>
                  {t(
                    busy()
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
        <Errored fallback={renderWebPushError}>
          <Loading on={props.push.command} fallback={null}>
            {(commandOutcome(), null)}
          </Loading>
        </Errored>
      </NotificationSection>
      <Errored fallback={renderWebPushError}>
        <Loading on={props.push.read} fallback={null}>
          <Show when={props.push.canReadPreferences ? latest(preferences) : (read(), undefined)}>
            {(current) => (
              <div class="settings-stack" inert={busy() || isPending(authoritativePreferences)}>
                <Show when={current().durableIdentity}>
                  <UserNotificationPreferences
                    disabled={!props.push.canManage || !props.actions.connected}
                    preferences={current().user}
                    onChange={(value) =>
                      submit(props.actions.onWebPushSetUserPreferences?.(value), {
                        scope: "user",
                        value,
                      })
                    }
                  />
                </Show>
                <DeviceNotificationPreferences
                  disabled={!props.push.canManage || !props.actions.connected}
                  preferences={current().device}
                  onChange={(value) =>
                    submit(props.actions.onWebPushSetDevicePreferences?.(value), {
                      scope: "device",
                      value,
                    })
                  }
                />
              </div>
            )}
          </Show>
        </Loading>
      </Errored>
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
