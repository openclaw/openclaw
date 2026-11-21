import { SettingsRow } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { errorIdForField, FieldRow, ToggleRow } from "./view-fields.tsx";
import type { CronProps } from "./view-types.ts";

export function ConditionTriggerRows(props: CronProps) {
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
            help={t(
              props.form.scheduleKind === "stream"
                ? "cron.form.streamConditionHelp"
                : "cron.form.conditionTriggerHelp",
            )}
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
