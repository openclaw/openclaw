import { For, Show } from "solid-js";
import type {
  WebPushDevicePreferences,
  WebPushNotificationPreferences,
} from "../../../../packages/gateway-protocol/src/schema/push.js";
import { SettingsRow, SettingsToggleRow } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveTimezoneSuggestions } from "../../lib/timezone-suggestions.ts";
import { SettingsSectionHeader } from "./settings-section-header.tsx";
import { SettingsSelectRow } from "./settings-select-row.tsx";

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

export function UserNotificationPreferences(props: {
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

export function DeviceNotificationPreferences(props: {
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
