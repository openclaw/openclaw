import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { createMemo, createSignal } from "solid-js";
import type { ChannelPickerOption } from "../../components/solid/channel-picker.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import type { CronFormState } from "../../lib/cron/types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  CronSelect,
  CronInput,
  ToggleRow,
  FieldRow,
  errorIdForField,
  inputIdForField,
} from "./view-fields.tsx";
import { DurationRow } from "./view-schedule.tsx";
import type { CronProps } from "./view-types.ts";
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
/** Where results go, in the order the Results section lists them. */
function DeliveryRows(
  props: CronProps & {
    isAgentTurn: boolean;
    supportsAnnounce: boolean;
    selectedDeliveryMode: CronFormState["deliveryMode"];
    channelOptions: readonly ChannelPickerOption[];
  },
) {
  return (
    <>
      <CronSelect
        {...props}
        field="deliveryMode"
        label={t("cron.form.deliveryModeLabel")}
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
            options={props.channelOptions}
            channel
          />
          <CronSelect
            {...props}
            field="deliveryTarget"
            label={t("cron.form.deliveryTarget")}
            help={
              props.form.deliveryTarget === "owner" ? t("cron.form.ownerTargetHelp") : undefined
            }
            options={[
              { value: "", label: t("cron.form.channelTarget") },
              { value: "owner", label: t("cron.form.ownerTarget") },
            ]}
          />
          {props.form.deliveryTarget !== "owner" ? (
            <CronInput
              {...props}
              field="deliveryTo"
              label={t("cron.form.to")}
              help={t("cron.form.toHelp")}
              list="cron-delivery-to-suggestions"
              placeholder={t("cron.form.toPlaceholder")}
            />
          ) : undefined}
          <CronSelect
            {...props}
            field="deliveryDirectPolicy"
            label={t("cron.form.directPolicy")}
            help={t("cron.form.directPolicyHelp")}
            errorKey="deliveryDirectPolicy"
            options={[
              { value: "", label: t("cron.form.defaultPolicy") },
              { value: "allow", label: t("cron.form.allowDirect") },
              { value: "block", label: t("cron.form.blockDirect") },
            ]}
          />
          {props.isAgentTurn ? (
            <CronInput
              {...props}
              field="deliveryAccountId"
              label={t("cron.form.accountId")}
              help={t("cron.form.accountIdHelp")}
              list="cron-delivery-account-suggestions"
              placeholder="default"
            />
          ) : undefined}
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
      {props.isAgentTurn ? (
        <ToggleRow
          {...props}
          field="payloadIncludeReasoning"
          label={t("cron.form.includeReasoning")}
          help={t("cron.form.includeReasoningHelp")}
        />
      ) : undefined}
      {props.selectedDeliveryMode !== "none" ? (
        <ToggleRow
          {...props}
          field="deliveryBestEffort"
          label={t("cron.form.bestEffortDelivery")}
          help={t("cron.form.bestEffortHelp")}
        />
      ) : undefined}
    </>
  );
}
/** Fields the Advanced sections hold; a validation error on one opens the disclosure. */
const ADVANCED_FIELDS = [
  "timeoutSeconds",
  "activeHoursStart",
  "activeHoursEnd",
  "activeHoursTimezone",
  "triggerScript",
  "deliveryMode",
  "deliveryDirectPolicy",
  "deliveryTo",
  "failureAlertAfter",
  "failureAlertCooldownSeconds",
  "staggerAmount",
  "cronTz",
] as const;
/**
 * Every setting beyond the prompt, schedule, model, agent and action, behind one quiet
 * disclosure, sorted into one section per concern. A validation error inside opens it.
 */
export function Advanced(
  props: CronProps & {
    isAgentTurn: boolean;
    supportsAnnounce: boolean;
    selectedDeliveryMode: CronFormState["deliveryMode"];
  },
) {
  const isCronSchedule = () => props.form.scheduleKind === "cron";
  const channelOptions = createMemo(() => buildChannelOptions(props));
  const [open, setOpen] = createSignal(false);
  const hasAdvancedError = createMemo(() =>
    ADVANCED_FIELDS.some((field) => Boolean(props.fieldErrors[field])),
  );
  return (
    <details
      class="cron-advanced"
      // A validation change can reveal the section. Native toggles keep the user's
      // choice while the same error remains.
      open={hasAdvancedError() || open()}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary class="cron-advanced__summary" data-test-id="cron-advanced">
        {t("cron.form.advanced")}
        <Icon name="chevronDown" />
        {props.form.triggerEnabled ? (
          <span class="cron-trigger-summary">
            <Icon name="gitBranch" /> {t("cron.form.triggerConfigured")}
          </span>
        ) : undefined}
      </summary>
      <div class="cron-advanced__sections">
        <SettingsSection title={t("cron.detail.generalSection")}>
          <CronInput
            {...props}
            field="description"
            label={t("cron.form.description")}
            placeholder={t("cron.form.descriptionPlaceholder")}
          />
          <CronSelect
            {...props}
            field="ownerProfileId"
            label={t("cron.form.humanOwner")}
            help={t("cron.form.humanOwnerHelp")}
            disabled={!props.editingJob || !props.canManage}
            options={
              props.ownerOptions ?? [
                {
                  value: props.form.ownerProfileId,
                  label: props.form.ownerProfileId || t("cron.form.ownerUnassigned"),
                },
              ]
            }
          />
        </SettingsSection>
        <SettingsSection title={t("cron.form.advancedTask")}>
          {props.form.payloadLocked ? (
            <FieldRow
              label={t("cron.form.action")}
              controlId={inputIdForField("payloadKind")}
              control={
                <input
                  id={inputIdForField("payloadKind")}
                  class="settings-input"
                  value={
                    props.form.payloadKind === "script"
                      ? t("cron.form.script")
                      : t("cron.form.command")
                  }
                  readonly
                />
              }
            />
          ) : (
            <CronSelect
              {...props}
              field="payloadKind"
              label={t("cron.form.action")}
              options={[
                { value: "systemEvent", label: t("cron.form.systemEvent") },
                { value: "agentTurn", label: t("cron.form.agentTurn") },
              ]}
            />
          )}
          {props.isAgentTurn ? (
            <>
              <CronInput
                {...props}
                field="timeoutSeconds"
                label={t("cron.form.timeoutSeconds")}
                help={t("cron.form.timeoutHelp")}
                errorKey="timeoutSeconds"
                placeholder={t("cron.form.timeoutPlaceholder")}
              />
              <ToggleRow
                {...props}
                field="payloadLightContext"
                label={t("cron.form.lightContext")}
                help={t("cron.form.lightContextHelp")}
              />
            </>
          ) : undefined}
        </SettingsSection>
        {isCronSchedule() ? (
          <SettingsSection title={t("cron.form.advancedTiming")}>
            <CronInput
              {...props}
              field="cronTz"
              errorKey="cronTz"
              label={t("cron.form.timezoneOptional")}
              help={t("cron.form.timezoneHelp")}
              list="cron-tz-suggestions"
              placeholder={t("cron.form.timezonePlaceholder")}
            />
            <ToggleRow
              {...props}
              field="scheduleExact"
              label={t("cron.form.exactTiming")}
              help={t("cron.form.exactTimingHelp")}
            />
            <DurationRow {...props} kind="stagger" />
          </SettingsSection>
        ) : undefined}
        <SettingsSection title={t("cron.form.advancedConditions")}>
          <ToggleRow
            {...props}
            field="activeHoursEnabled"
            label={t("cron.form.activeHours")}
            help={t("cron.form.activeHoursHelp")}
          />
          {props.form.activeHoursEnabled ? (
            <>
              <CronInput
                {...props}
                field="activeHoursStart"
                label={t("cron.form.activeHoursStart")}
                errorKey="activeHoursStart"
                placeholder="09:00"
              />
              <CronInput
                {...props}
                field="activeHoursEnd"
                label={t("cron.form.activeHoursEnd")}
                errorKey="activeHoursEnd"
                placeholder="17:00"
              />
              <CronInput
                {...props}
                field="activeHoursTimezone"
                label={t("cron.form.timezoneOptional")}
                help={t("cron.form.activeHoursTimezoneHelp")}
                errorKey="activeHoursTimezone"
                list="cron-tz-suggestions"
                placeholder={t("cron.form.timezonePlaceholder")}
              />
            </>
          ) : undefined}
          <ToggleRow
            {...props}
            field="idleOnly"
            label={t("cron.form.idleOnly")}
            help={t("cron.form.idleOnlyHelp")}
          />
          {props.isAgentTurn ? (
            <ToggleRow
              {...props}
              field="payloadSkipIfScratchEmpty"
              label={t("cron.form.skipIfScratchEmpty")}
              help={t("cron.form.skipIfScratchEmptyHelp")}
            />
          ) : undefined}
          <TriggerRows {...props} />
        </SettingsSection>
        <SettingsSection title={t("cron.form.advancedResults")}>
          <DeliveryRows {...props} channelOptions={channelOptions()} />
        </SettingsSection>
        {props.isAgentTurn ? (
          <SettingsSection title={t("cron.form.failureAlerts")}>
            <FailureAlertRows {...props} channelOptions={channelOptions()} />
          </SettingsSection>
        ) : undefined}
      </div>
    </details>
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
                    onInput={(event) =>
                      props.onFormChange({ triggerScript: event.currentTarget.value })
                    }
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
        label={t("cron.form.failureAlertSend")}
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
            field="failureAlertDeliveryMode"
            label={t("cron.form.failureAlertMode")}
            options={[
              { value: "", label: t("cron.form.failureAlertInherit") },
              { value: "announce", label: t("cron.form.failureAlertAnnounce") },
              { value: "webhook", label: t("cron.form.failureAlertWebhook") },
            ]}
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
