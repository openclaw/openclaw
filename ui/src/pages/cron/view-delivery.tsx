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
export function DeliverySection(componentProps: {
  props: CronProps;
  ctx: {
    supportsAnnounce: boolean;
    selectedDeliveryMode: CronFormState["deliveryMode"];
  };
}) {
  const channelOptions = createMemo(() => buildChannelOptions(componentProps.props));
  return (
    <SettingsSection
      title={t("cron.detail.deliverySection")}
      children={
        <>
          <CronSelect
            props={componentProps.props}
            field="deliveryMode"
            options={{
              label: t("cron.form.deliveryModeLabel"),
              help: t("cron.form.deliveryHelp"),
              value: componentProps.ctx.selectedDeliveryMode,
              errorKey: "deliveryMode",
              options: [
                ...(componentProps.ctx.selectedDeliveryMode === ""
                  ? [{ value: "", label: t("cron.form.selectDeliveryMode"), disabled: true }]
                  : []),
                ...(componentProps.ctx.supportsAnnounce
                  ? [{ value: "announce", label: t("cron.form.announceDefault") }]
                  : []),
                { value: "webhook", label: t("cron.form.webhookPost") },
                { value: "none", label: t("cron.form.noneInternal") },
              ],
            }}
          />
          {componentProps.ctx.selectedDeliveryMode === "announce" ? (
            <>
              <CronSelect
                props={componentProps.props}
                field="deliveryChannel"
                options={{
                  label: t("cron.form.channel"),
                  help: t("cron.form.channelHelp"),
                  options: channelOptions(),
                  channel: true,
                }}
              />
              <CronInput
                props={componentProps.props}
                field="deliveryTo"
                options={{
                  label: t("cron.form.to"),
                  help: t("cron.form.toHelp"),
                  list: "cron-delivery-to-suggestions",
                  placeholder: t("cron.form.toPlaceholder"),
                }}
              />
            </>
          ) : undefined}
          {componentProps.ctx.selectedDeliveryMode === "webhook" ? (
            <CronInput
              props={componentProps.props}
              field="deliveryTo"
              options={{
                label: t("cron.form.webhookUrl"),
                required: true,
                help: t("cron.form.webhookHelp"),
                errorKey: "deliveryTo",
                list: "cron-delivery-to-suggestions",
                placeholder: t("cron.form.webhookPlaceholder"),
              }}
            />
          ) : undefined}
        </>
      }
    />
  );
}
export function Advanced(componentProps: {
  props: CronProps;
  ctx: {
    mode: CronPanelMode;
    isAgentTurn: boolean;
    selectedDeliveryMode: CronFormState["deliveryMode"];
  };
}) {
  const isCronSchedule = createMemo(() => componentProps.props.form.scheduleKind === "cron");
  const channelOptions = createMemo(() => buildChannelOptions(componentProps.props));
  // Collapsible section: the summary stands in for the section heading, the
  // body keeps the one-group-of-rows settings shape.
  return (
    <section class="settings-section">
      <details class="cron-advanced">
        <summary class="settings-section__heading cron-advanced__summary">
          {t("cron.form.advanced")}
          {componentProps.props.form.triggerEnabled ? (
            <span class="cron-trigger-summary">
              <Icon name="gitBranch" /> {t("cron.form.triggerConfigured")}
            </span>
          ) : undefined}
        </summary>
        <p class="settings-section__desc">{t("cron.form.advancedHelp")}</p>
        <div class="settings-group">
          <TriggerRows {...componentProps.props} />
          <CronInput
            props={componentProps.props}
            field="description"
            options={{
              label: t("cron.form.description"),
              placeholder: t("cron.form.descriptionPlaceholder"),
            }}
          />
          {componentProps.ctx.mode === "create" ? (
            <ToggleRow
              props={componentProps.props}
              field="enabled"
              params={{
                label: t("cron.form.startEnabled"),
              }}
            />
          ) : undefined}
          <CronSelect
            props={componentProps.props}
            field="wakeMode"
            options={{
              label: t("cron.form.wakeMode"),
              help: t("cron.form.wakeModeHelp"),
              options: [
                { value: "now", label: t("cron.form.now") },
                { value: "next-heartbeat", label: t("cron.form.nextHeartbeat") },
              ],
            }}
          />
          {componentProps.ctx.isAgentTurn ? (
            <CronInput
              props={componentProps.props}
              field="timeoutSeconds"
              options={{
                label: t("cron.form.timeoutSeconds"),
                help: t("cron.form.timeoutHelp"),
                errorKey: "timeoutSeconds",
                placeholder: t("cron.form.timeoutPlaceholder"),
              }}
            />
          ) : undefined}
          {componentProps.props.form.scheduleKind === "at" ||
          componentProps.props.form.scheduleKind === "on-exit" ? (
            <ToggleRow
              props={componentProps.props}
              field="deleteAfterRun"
              params={{
                label: t("cron.form.deleteAfterRun"),
                help: t("cron.form.deleteAfterRunHelp"),
              }}
            />
          ) : undefined}
          <ToggleRow
            props={componentProps.props}
            field="clearAgent"
            params={{
              label: t("cron.form.clearAgentOverride"),
              help: t("cron.form.clearAgentHelp"),
            }}
          />
          <CronInput
            props={componentProps.props}
            field="sessionKey"
            options={{
              label: t("cron.form.sessionKey"),
              help: t("cron.form.sessionKeyHelp"),
              placeholder: "agent:main:main",
            }}
          />
          {isCronSchedule() ? (
            <>
              <ToggleRow
                props={componentProps.props}
                field="scheduleExact"
                params={{
                  label: t("cron.form.exactTiming"),
                  help: t("cron.form.exactTimingHelp"),
                }}
              />
              <DurationRow props={componentProps.props} kind="stagger" />
            </>
          ) : undefined}
          {componentProps.ctx.isAgentTurn ? (
            <>
              <CronInput
                props={componentProps.props}
                field="deliveryAccountId"
                options={{
                  label: t("cron.form.accountId"),
                  help: t("cron.form.accountIdHelp"),
                  list: "cron-delivery-account-suggestions",
                  disabled: componentProps.ctx.selectedDeliveryMode !== "announce",
                  placeholder: "default",
                }}
              />
              <ToggleRow
                props={componentProps.props}
                field="payloadLightContext"
                params={{
                  label: t("cron.form.lightContext"),
                  help: t("cron.form.lightContextHelp"),
                }}
              />
              <FailureAlertRows props={componentProps.props} channelOptions={channelOptions()} />
            </>
          ) : undefined}
          {componentProps.ctx.selectedDeliveryMode !== "none" ? (
            <ToggleRow
              props={componentProps.props}
              field="deliveryBestEffort"
              params={{
                label: t("cron.form.bestEffortDelivery"),
                help: t("cron.form.bestEffortHelp"),
              }}
            />
          ) : undefined}
        </div>
      </details>
    </section>
  );
}
function TriggerRows(props: CronProps) {
  const scriptPayload = createMemo(() => props.form.payloadKind === "script");
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
            props={props}
            field="triggerEnabled"
            params={{
              label: t("cron.form.conditionTrigger"),
              help: t("cron.form.conditionTriggerHelp"),
            }}
          />
          {props.form.triggerEnabled ? (
            <>
              <FieldRow
                params={{
                  label: t("cron.form.triggerScript"),
                  controlId: "cron-trigger-script",
                  required: true,
                  help: t("cron.form.triggerScriptHelp"),
                  error: props.fieldErrors.triggerScript,
                  errorId: errorIdForField("triggerScript"),
                  stacked: true,
                  wide: true,
                  control: (
                    <textarea
                      id="cron-trigger-script"
                      class="settings-input cron-trigger-script mono"
                      rows="8"
                      spellCheck="false"
                      aria-invalid={props.fieldErrors.triggerScript ? "true" : "false"}
                      aria-describedby={
                        props.fieldErrors.triggerScript
                          ? errorIdForField("triggerScript")
                          : undefined
                      }
                      prop:value={props.form.triggerScript}
                      onInput={(event) => {
                        const target = event.currentTarget;
                        if (target instanceof HTMLTextAreaElement) {
                          props.onFormChange({ triggerScript: target.value });
                        }
                      }}
                    />
                  ),
                }}
              />
              <ToggleRow
                props={props}
                field="triggerOnce"
                params={{
                  label: t("cron.form.triggerOnce"),
                  help: t("cron.form.triggerOnceHelp"),
                }}
              />
            </>
          ) : undefined}
        </>
      )}
    </>
  );
}
function FailureAlertRows(componentProps: {
  props: CronProps;
  channelOptions: readonly ChannelPickerOption[];
}) {
  return (
    <>
      <CronSelect
        props={componentProps.props}
        field="failureAlertMode"
        options={{
          label: t("cron.form.failureAlerts"),
          help: t("cron.form.failureAlertsHelp"),
          options: [
            { value: "inherit", label: t("cron.form.failureAlertInherit") },
            { value: "disabled", label: t("cron.form.failureAlertDisabled") },
            { value: "custom", label: t("cron.form.failureAlertCustom") },
          ],
        }}
      />
      {componentProps.props.form.failureAlertMode === "custom" ? (
        <>
          <CronInput
            props={componentProps.props}
            field="failureAlertAfter"
            options={{
              label: t("cron.form.failureAlertAfter"),
              help: t("cron.form.failureAlertAfterHelp"),
              errorKey: "failureAlertAfter",
              placeholder: t("cron.form.failureAlertInherit"),
            }}
          />
          <CronInput
            props={componentProps.props}
            field="failureAlertCooldownSeconds"
            options={{
              label: t("cron.form.failureAlertCooldown"),
              help: t("cron.form.failureAlertCooldownHelp"),
              errorKey: "failureAlertCooldownSeconds",
              placeholder: t("cron.form.failureAlertInherit"),
            }}
          />
          <CronSelect
            props={componentProps.props}
            field="failureAlertChannel"
            options={{
              label: t("cron.form.failureAlertChannel"),
              options: componentProps.channelOptions,
              channel: true,
            }}
          />
          <CronInput
            props={componentProps.props}
            field="failureAlertTo"
            options={{
              label: t("cron.form.failureAlertTo"),
              help: t("cron.form.failureAlertToHelp"),
              list: "cron-failure-alert-to-suggestions",
              placeholder: t("cron.form.failureAlertToPlaceholder"),
            }}
          />
          <CronSelect
            props={componentProps.props}
            field="failureAlertDeliveryMode"
            options={{
              label: t("cron.form.failureAlertMode"),
              options: [
                { value: "", label: t("cron.form.failureAlertInherit") },
                { value: "announce", label: t("cron.form.failureAlertAnnounce") },
                { value: "webhook", label: t("cron.form.failureAlertWebhook") },
              ],
            }}
          />
          <CronInput
            props={componentProps.props}
            field="failureAlertAccountId"
            options={{
              label: t("cron.form.failureAlertAccountId"),
              placeholder: t("cron.form.failureAlertAccountPlaceholder"),
            }}
          />
        </>
      ) : undefined}
    </>
  );
}
