import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { createMemo } from "solid-js";
import type { ChannelPickerOption } from "../../components/channel-picker.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSection, SettingsRow } from "../../components/solid/settings-ui.tsx";
import type { CronFormState } from "../../lib/cron/types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { CronSelect, CronInput, ToggleRow, FieldRow, errorIdForField } from "./view-fields.tsx";
import { DurationRow } from "./view-schedule.tsx";
import type { CronProps, CronPanelMode } from "./view-types.ts";
function buildChannelOptions(data: CronProps): ChannelPickerOption[] {
  return [
    { value: "last", label: "last", kind: "neutral" },
    ...uniqueStrings(data.channels.filter(Boolean)).map((value) => ({
      value,
      label:
        data.channelMeta?.find((entry) => entry.id === value)?.label ||
        data.channelLabels?.[value] ||
        value,
    })),
  ];
}
export function DeliverySection(
  props: CronProps & {
    supportsAnnounce: boolean;
    selectedDeliveryMode: CronFormState["deliveryMode"];
  },
) {
  const channelOptions = createMemo(() => buildChannelOptions(props));
  return (
    <SettingsSection title={t("cron.detail.deliverySection")}>
      <CronSelect
        {...props}
        field="deliveryMode"
        label={t("cron.form.deliveryModeLabel")}
        help={t("cron.form.deliveryHelp")}
        value={props.selectedDeliveryMode}
        errorKey="deliveryMode"
        options={[
          ...(props.selectedDeliveryMode === ""
            ? [{ value: "", label: t("cron.form.selectDeliveryMode"), disabled: true }]
            : []),
          ...(props.supportsAnnounce
            ? [{ value: "announce", label: t("cron.form.announceDefault") }]
            : []),
          { value: "webhook", label: t("cron.form.webhookPost") },
          { value: "none", label: t("cron.form.noneInternal") },
        ]}
      />
      {props.selectedDeliveryMode === "announce" ? (
        <>
          <CronSelect
            {...props}
            field="deliveryChannel"
            label={t("cron.form.channel")}
            help={t("cron.form.channelHelp")}
            options={channelOptions()}
            channel
          />
          <CronInput
            {...props}
            field="deliveryTo"
            label={t("cron.form.to")}
            help={t("cron.form.toHelp")}
            list="cron-delivery-to-suggestions"
            placeholder={t("cron.form.toPlaceholder")}
          />
        </>
      ) : undefined}
      {props.selectedDeliveryMode === "webhook" ? (
        <CronInput
          {...props}
          field="deliveryTo"
          label={t("cron.form.webhookUrl")}
          required
          help={t("cron.form.webhookHelp")}
          errorKey="deliveryTo"
          list="cron-delivery-to-suggestions"
          placeholder={t("cron.form.webhookPlaceholder")}
        />
      ) : undefined}
    </SettingsSection>
  );
}
export function Advanced(
  props: CronProps & {
    mode: CronPanelMode;
    isAgentTurn: boolean;
    selectedDeliveryMode: CronFormState["deliveryMode"];
  },
) {
  const isCronSchedule = () => props.form.scheduleKind === "cron";
  const channelOptions = createMemo(() => buildChannelOptions(props));
  // Collapsible section: the summary stands in for the section heading, the
  // body keeps the one-group-of-rows settings shape.
  return (
    <section class="settings-section">
      <details class="cron-advanced">
        <summary class="settings-section__heading cron-advanced__summary">
          {t("cron.form.advanced")}
          {props.form.triggerEnabled ? (
            <span class="cron-trigger-summary">
              <Icon name="gitBranch" /> {t("cron.form.triggerConfigured")}
            </span>
          ) : undefined}
        </summary>
        <p class="settings-section__desc">{t("cron.form.advancedHelp")}</p>
        <div class="settings-group">
          <TriggerRows {...props} />
          <CronInput
            {...props}
            field="description"
            label={t("cron.form.description")}
            placeholder={t("cron.form.descriptionPlaceholder")}
          />
          {props.mode === "create" ? (
            <ToggleRow {...props} field="enabled" label={t("cron.form.startEnabled")} />
          ) : undefined}
          <CronSelect
            {...props}
            field="wakeMode"
            label={t("cron.form.wakeMode")}
            help={t("cron.form.wakeModeHelp")}
            options={[
              { value: "now", label: t("cron.form.now") },
              { value: "next-heartbeat", label: t("cron.form.nextHeartbeat") },
            ]}
          />
          {props.isAgentTurn ? (
            <CronInput
              {...props}
              field="timeoutSeconds"
              label={t("cron.form.timeoutSeconds")}
              help={t("cron.form.timeoutHelp")}
              errorKey="timeoutSeconds"
              placeholder={t("cron.form.timeoutPlaceholder")}
            />
          ) : undefined}
          {props.form.scheduleKind === "at" || props.form.scheduleKind === "on-exit" ? (
            <ToggleRow
              {...props}
              field="deleteAfterRun"
              label={t("cron.form.deleteAfterRun")}
              help={t("cron.form.deleteAfterRunHelp")}
            />
          ) : undefined}
          <ToggleRow
            {...props}
            field="clearAgent"
            label={t("cron.form.clearAgentOverride")}
            help={t("cron.form.clearAgentHelp")}
          />
          <CronInput
            {...props}
            field="sessionKey"
            label={t("cron.form.sessionKey")}
            help={t("cron.form.sessionKeyHelp")}
            placeholder="agent:main:main"
          />
          {isCronSchedule() ? (
            <>
              <ToggleRow
                {...props}
                field="scheduleExact"
                label={t("cron.form.exactTiming")}
                help={t("cron.form.exactTimingHelp")}
              />
              <DurationRow {...props} kind="stagger" />
            </>
          ) : undefined}
          {props.isAgentTurn ? (
            <>
              <CronInput
                {...props}
                field="deliveryAccountId"
                label={t("cron.form.accountId")}
                help={t("cron.form.accountIdHelp")}
                list="cron-delivery-account-suggestions"
                disabled={props.selectedDeliveryMode !== "announce"}
                placeholder="default"
              />
              <ToggleRow
                {...props}
                field="payloadLightContext"
                label={t("cron.form.lightContext")}
                help={t("cron.form.lightContextHelp")}
              />
              <FailureAlertRows {...props} channelOptions={channelOptions()} />
            </>
          ) : undefined}
          {props.selectedDeliveryMode !== "none" ? (
            <ToggleRow
              {...props}
              field="deliveryBestEffort"
              label={t("cron.form.bestEffortDelivery")}
              help={t("cron.form.bestEffortHelp")}
            />
          ) : undefined}
        </div>
      </details>
    </section>
  );
}
function TriggerRows(props: CronProps) {
  const scriptPayload = () => props.form.payloadKind === "script";
  return (
    <>
      {!scriptPayload() && props.status === null ? undefined : props.status?.triggersEnabled !==
          true || scriptPayload() ? (
        <SettingsRow
          title={t("cron.form.conditionTrigger")}
          description={
            scriptPayload()
              ? t("cron.errors.triggerScriptPayloadUnsupported")
              : props.form.triggerEnabled
                ? t("cron.form.triggerDisabledConfigured")
                : t("cron.form.triggerDisabled")
          }
          control={
            props.form.triggerEnabled ? (
              <button
                type="button"
                class="btn btn--sm"
                onClick={() => props.onFormChange({ triggerEnabled: false })}
              >
                {t("cron.form.clearTrigger")}
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ToggleRow
            {...props}
            field="triggerEnabled"
            label={t("cron.form.conditionTrigger")}
            help={t("cron.form.conditionTriggerHelp")}
          />
          {props.form.triggerEnabled ? (
            <>
              <FieldRow
                label={t("cron.form.triggerScript")}
                controlId="cron-trigger-script"
                required
                help={t("cron.form.triggerScriptHelp")}
                error={props.fieldErrors.triggerScript}
                errorId={errorIdForField("triggerScript")}
                stacked
                wide
                control={
                  <textarea
                    id="cron-trigger-script"
                    class="settings-input cron-trigger-script mono"
                    rows="8"
                    spellcheck="false"
                    aria-invalid={props.fieldErrors.triggerScript ? "true" : "false"}
                    aria-describedby={
                      props.fieldErrors.triggerScript ? errorIdForField("triggerScript") : undefined
                    }
                    value={props.form.triggerScript}
                    onInput={(event) => {
                      const target = event.currentTarget;
                      if (target instanceof HTMLTextAreaElement) {
                        props.onFormChange({ triggerScript: target.value });
                      }
                    }}
                  />
                }
              />
              <ToggleRow
                {...props}
                field="triggerOnce"
                label={t("cron.form.triggerOnce")}
                help={t("cron.form.triggerOnceHelp")}
              />
            </>
          ) : undefined}
        </>
      )}
    </>
  );
}
function FailureAlertRows(
  props: CronProps & {
    channelOptions: readonly ChannelPickerOption[];
  },
) {
  return (
    <>
      <CronSelect
        {...props}
        field="failureAlertMode"
        label={t("cron.form.failureAlerts")}
        help={t("cron.form.failureAlertsHelp")}
        options={[
          { value: "inherit", label: t("cron.form.failureAlertInherit") },
          { value: "disabled", label: t("cron.form.failureAlertDisabled") },
          { value: "custom", label: t("cron.form.failureAlertCustom") },
        ]}
      />
      {props.form.failureAlertMode === "custom" ? (
        <>
          <CronInput
            {...props}
            field="failureAlertAfter"
            label={t("cron.form.failureAlertAfter")}
            help={t("cron.form.failureAlertAfterHelp")}
            errorKey="failureAlertAfter"
            placeholder={t("cron.form.failureAlertInherit")}
          />
          <CronInput
            {...props}
            field="failureAlertCooldownSeconds"
            label={t("cron.form.failureAlertCooldown")}
            help={t("cron.form.failureAlertCooldownHelp")}
            errorKey="failureAlertCooldownSeconds"
            placeholder={t("cron.form.failureAlertInherit")}
          />
          <CronSelect
            {...props}
            field="failureAlertChannel"
            label={t("cron.form.failureAlertChannel")}
            options={props.channelOptions}
            channel
          />
          <CronInput
            {...props}
            field="failureAlertTo"
            label={t("cron.form.failureAlertTo")}
            help={t("cron.form.failureAlertToHelp")}
            list="cron-failure-alert-to-suggestions"
            placeholder={t("cron.form.failureAlertToPlaceholder")}
          />
          <CronSelect
            {...props}
            field="failureAlertDeliveryMode"
            label={t("cron.form.failureAlertMode")}
            options={[
              { value: "", label: t("cron.form.failureAlertInherit") },
              { value: "announce", label: t("cron.form.failureAlertAnnounce") },
              { value: "webhook", label: t("cron.form.failureAlertWebhook") },
            ]}
          />
          <CronInput
            {...props}
            field="failureAlertAccountId"
            label={t("cron.form.failureAlertAccountId")}
            placeholder={t("cron.form.failureAlertAccountPlaceholder")}
          />
        </>
      ) : undefined}
    </>
  );
}
