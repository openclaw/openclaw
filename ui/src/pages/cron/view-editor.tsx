import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { createMemo, For } from "solid-js";
import { highlightCodeHtml } from "../../components/markdown-code-blocks.ts";
import { renderModelPicker } from "../../components/model-picker.ts";
import { providerIdFromModelRef } from "../../components/provider-icon.ts";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import type { CronFormState } from "../../lib/cron/types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { DeliverySection, Advanced } from "./view-delivery.tsx";
import {
  collectBlockingFields,
  focusFormField,
  FieldRow,
  errorIdForField,
  inputIdForField,
  CronSelect,
  CronInput,
} from "./view-fields.tsx";
import { ScheduleSection } from "./view-schedule.tsx";
import type { CronProps, CronPanelMode } from "./view-types.ts";
import "./scratch-editor.ts";
export function Editor(
  props: CronProps & {
    mode: CronPanelMode;
  },
) {
  const payloadLocked = () => props.form.payloadLocked;
  const isAgentTurn = () => !payloadLocked() && props.form.payloadKind === "agentTurn";
  const supportsAnnounce = () =>
    props.form.sessionTarget !== "main" &&
    (props.form.payloadKind === "agentTurn" || payloadLocked());
  const selectedDeliveryMode = () =>
    props.form.deliveryMode === "announce" && !supportsAnnounce()
      ? "none"
      : props.form.deliveryMode;
  const blockingFields = createMemo(() =>
    collectBlockingFields(props.fieldErrors, props.form, selectedDeliveryMode()),
  );
  const blockedByValidation = () => props.canManage && !props.busy && blockingFields().length > 0;
  const submitDisabledReason = () =>
    blockedByValidation() && !props.canSubmit
      ? blockingFields().length === 1
        ? t("cron.form.fixFields", { count: String(blockingFields().length) })
        : t("cron.form.fixFieldsPlural", { count: String(blockingFields().length) })
      : "";
  return (
    <>
      <fieldset
        class="cron-editor"
        disabled={props.busy || !props.canManage}
        aria-busy={props.busy ? "true" : "false"}
      >
        <PromptSection {...props} payloadLocked={payloadLocked()} isAgentTurn={isAgentTurn()} />{" "}
        <GeneralSection {...props} />
        <ScheduleSection {...props} />
        <DeliverySection
          {...props}
          supportsAnnounce={supportsAnnounce()}
          selectedDeliveryMode={selectedDeliveryMode()}
        />
        <Advanced
          {...props}
          mode={props.mode}
          isAgentTurn={isAgentTurn()}
          selectedDeliveryMode={selectedDeliveryMode()}
        />
        {blockedByValidation() ? (
          <div class="cron-form-status" role="status" aria-live="polite">
            <div class="cron-form-status__title">{t("cron.form.cantAddYet")}</div>
            <div class="cron-help">{t("cron.form.fillRequired")}</div>
            <ul class="cron-form-status__list">
              <For each={blockingFields()} keyed={(field) => field.inputId}>
                {(field) => (
                  <li>
                    <button
                      type="button"
                      class="cron-form-status__link"
                      onClick={() => focusFormField(field().inputId)}
                    >
                      {field().label}: {t(field().message)}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </div>
        ) : undefined}
        {props.canManage ? (
          <div class="cron-editor-actions">
            <button
              class="btn primary"
              data-test-id="cron-submit"
              disabled={props.busy || !props.canSubmit}
              onClick={() => props.onSubmit()}
            >
              {props.busy
                ? t("cron.form.saving")
                : props.mode === "job"
                  ? t("cron.form.saveChanges")
                  : t("cron.form.createTask")}
            </button>
            {props.mode === "create" ? (
              <button
                class="btn"
                data-test-id="cron-submit-run"
                disabled={props.busy || !props.canSubmit}
                onClick={() => props.onSubmitRunNow()}
              >
                {t("cron.form.createAndRun")}
              </button>
            ) : undefined}
            <button class="btn" disabled={props.busy} onClick={() => props.onClosePanel()}>
              {t("cron.form.cancel")}
            </button>
            {submitDisabledReason() ? (
              <div class="cron-submit-reason" aria-live="polite">
                {submitDisabledReason()}
              </div>
            ) : undefined}
          </div>
        ) : undefined}
      </fieldset>
      {props.editingJob && props.canManage ? (
        <openclaw-cron-scratch-editor
          prop:jobId={props.editingJob.id}
          prop:gateway={props.gateway}
        />
      ) : undefined}
    </>
  );
}
// Only the read-only payload kinds carry source text; the rest are prose prompts,
// so an empty language keeps them on the plain editable textarea.
const CRON_PAYLOAD_CODE_LANGUAGES: Record<CronFormState["payloadKind"], string> = {
  script: "javascript",
  command: "bash",
  systemEvent: "",
  agentTurn: "",
};
function PromptSection(
  props: CronProps & {
    payloadLocked: boolean;
    isAgentTurn: boolean;
  },
) {
  const lockedPayloadLabel = () =>
    props.form.payloadKind === "script"
      ? t("cron.form.script")
      : props.form.payloadKind === "agentTurn"
        ? t("cron.form.assistantTaskPrompt")
        : t("cron.form.command");
  const promptLabel = () =>
    props.payloadLocked
      ? lockedPayloadLabel()
      : props.form.payloadKind === "systemEvent"
        ? t("cron.form.mainTimelineMessage")
        : t("cron.form.assistantTaskPrompt");
  const promptHelp = () =>
    props.payloadLocked
      ? t("cron.form.readOnlyPayloadHelp")
      : props.form.payloadKind === "systemEvent"
        ? t("cron.form.systemEventHelp")
        : t("cron.form.agentTurnHelp");
  // Script/command payloads are always read-only here, so they render as a highlighted
  // code block instead of a textarea; every other kind stays an editable field. The code
  // block carries no aria-invalid/describedby because validateCronForm skips payloadText
  // for locked payloads, so this branch can never render a payload error.
  const codeLanguage = () =>
    props.payloadLocked ? CRON_PAYLOAD_CODE_LANGUAGES[props.form.payloadKind] : "";
  const payloadText = () => props.form.payloadText;
  const actionLabel = () => t("cron.form.action");
  const modelLabel = () => t("cron.form.model");
  const modelError = () => props.fieldErrors.payloadModel;
  const modelOptions = createMemo(() =>
    uniqueStrings(props.modelSuggestions).map((value) => {
      const provider = providerIdFromModelRef(value);
      return { value, label: value, provider: provider ?? undefined };
    }),
  );
  return (
    <SettingsSection>
      {" "}
      <FieldRow
        label={promptLabel()}
        controlId={codeLanguage() ? "" : "cron-payload-text"}
        required
        help={promptHelp()}
        stacked
        wide
        error={props.fieldErrors.payloadText}
        errorId={errorIdForField("payloadText")}
        control={
          codeLanguage() ? (
            <pre
              id="cron-payload-text"
              class="code-block cron-payload-code"
              data-test-id="cron-payload-code"
              tabindex="0"
              role="region"
              aria-label={promptLabel()}
            >
              <SanitizedHtml
                tag="code"
                class="hljs"
                html={highlightCodeHtml(payloadText(), codeLanguage())}
              />
            </pre>
          ) : (
            <textarea
              id="cron-payload-text"
              class="settings-input"
              rows="6"
              value={payloadText()}
              readonly={props.payloadLocked}
              aria-required="true"
              placeholder={t("cron.form.promptPlaceholder")}
              aria-invalid={props.fieldErrors.payloadText ? "true" : "false"}
              aria-describedby={
                props.fieldErrors.payloadText ? errorIdForField("payloadText") : undefined
              }
              onInput={(e) =>
                props.onFormChange({
                  payloadText: e.currentTarget.value,
                })
              }
            />
          )
        }
      />
      {props.payloadLocked ? (
        <FieldRow
          label={actionLabel()}
          controlId={inputIdForField("payloadKind")}
          control={
            <input
              id={inputIdForField("payloadKind")}
              class="settings-input"
              value={lockedPayloadLabel()}
              readonly
            />
          }
        />
      ) : (
        <CronSelect
          {...props}
          field="payloadKind"
          label={actionLabel()}
          options={[
            { value: "systemEvent", label: t("cron.form.systemEvent") },
            { value: "agentTurn", label: t("cron.form.agentTurn") },
          ]}
        />
      )}
      {props.isAgentTurn ? (
        <>
          <FieldRow
            label={modelLabel()}
            controlId=""
            help={t("cron.form.modelHelp")}
            error={modelError()}
            errorId={errorIdForField("payloadModel")}
            control={
              <LitContent
                render={() =>
                  renderModelPicker({
                    id: "cron-payload-model-picker",
                    label: modelLabel(),
                    value: props.form.payloadModel,
                    options: [
                      { value: "", label: t("quickSettings.model.default") },
                      ...modelOptions(),
                    ],
                    custom: {
                      id: inputIdForField("payloadModel"),
                      label: t("cron.form.customModel"),
                      placeholder: t("cron.form.modelPlaceholder"),
                      invalid: Boolean(modelError()),
                      describedBy: modelError() ? errorIdForField("payloadModel") : undefined,
                    },
                    onChange: (payloadModel) => props.onFormChange({ payloadModel }),
                  })
                }
              />
            }
          />
          <CronInput
            {...props}
            field="payloadThinking"
            label={t("cron.form.thinking")}
            help={t("cron.form.thinkingHelp")}
            errorKey="payloadThinking"
            describeError={false}
            list="cron-thinking-suggestions"
            placeholder={t("cron.form.thinkingPlaceholder")}
          />
        </>
      ) : undefined}{" "}
    </SettingsSection>
  );
}
function GeneralSection(props: CronProps) {
  const sessionTarget = () => props.form.sessionTarget;
  const knownSessionTarget = () => sessionTarget() === "main" || sessionTarget() === "isolated";
  return (
    <SettingsSection title={t("cron.detail.generalSection")}>
      <CronInput
        {...props}
        field="name"
        label={t("cron.form.fieldName")}
        required
        errorKey="name"
        placeholder={t("cron.form.namePlaceholder")}
      />
      <CronInput
        {...props}
        field="agentId"
        label={t("cron.form.agentId")}
        help={t("cron.form.agentHelp")}
        list="cron-agent-suggestions"
        disabled={props.form.clearAgent}
        placeholder={t("cron.form.agentPlaceholder")}
      />
      <CronSelect
        {...props}
        field="sessionTarget"
        label={t("cron.form.runsIn")}
        help={t("cron.form.sessionHelp")}
        options={[
          { value: "main", label: t("cron.form.mainSession") },
          { value: "isolated", label: t("cron.form.isolatedSession") },
          ...(knownSessionTarget() ? [] : [{ value: sessionTarget(), label: sessionTarget() }]),
        ]}
      />
    </SettingsSection>
  );
}
