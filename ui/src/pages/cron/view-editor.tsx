import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { createMemo, For } from "solid-js";
import { isSystemMonitorDeclaration } from "../../../../src/cron/system-owned-declaration.js";
import { highlightCodeHtml } from "../../components/markdown-code-blocks.ts";
import { providerIdFromModelRef } from "../../components/provider-icon.ts";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import type { CronFormState } from "../../lib/cron/types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/lit-content.tsx";
import { CronModelPicker } from "./view-controls.tsx";
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
export function Editor(componentProps: { props: CronProps; mode: CronPanelMode }) {
  const payloadLocked = createMemo(() => componentProps.props.form.payloadLocked);
  const systemOwned = createMemo(
    () =>
      componentProps.mode === "job" &&
      isSystemMonitorDeclaration(componentProps.props.editingJob?.declarationKey),
  );
  const isAgentTurn = createMemo(
    () => !payloadLocked() && componentProps.props.form.payloadKind === "agentTurn",
  );
  const supportsAnnounce = createMemo(
    () =>
      componentProps.props.form.sessionTarget !== "main" &&
      (componentProps.props.form.payloadKind === "agentTurn" || payloadLocked()),
  );
  const selectedDeliveryMode = createMemo(() =>
    componentProps.props.form.deliveryMode === "announce" && !supportsAnnounce()
      ? "none"
      : componentProps.props.form.deliveryMode,
  );
  const blockingFields = createMemo(() =>
    collectBlockingFields(
      componentProps.props.fieldErrors,
      componentProps.props.form,
      selectedDeliveryMode(),
    ),
  );
  const blockedByValidation = createMemo(
    () =>
      componentProps.props.canManage && !componentProps.props.busy && blockingFields().length > 0,
  );
  const submitDisabledReason = createMemo(() =>
    blockedByValidation() && !componentProps.props.canSubmit
      ? blockingFields().length === 1
        ? t("cron.form.fixFields", { count: String(blockingFields().length) })
        : t("cron.form.fixFieldsPlural", { count: String(blockingFields().length) })
      : "",
  );
  return (
    <fieldset
      class="cron-editor"
      disabled={componentProps.props.busy || !componentProps.props.canManage || systemOwned()}
      aria-busy={String(componentProps.props.busy)}
    >
      <PromptSection
        props={componentProps.props}
        ctx={{ payloadLocked: payloadLocked(), isAgentTurn: isAgentTurn() }}
      />{" "}
      <GeneralSection {...componentProps.props} />
      <ScheduleSection {...componentProps.props} />
      <DeliverySection
        props={componentProps.props}
        ctx={{
          supportsAnnounce: supportsAnnounce(),
          selectedDeliveryMode: selectedDeliveryMode(),
        }}
      />
      <Advanced
        props={componentProps.props}
        ctx={{
          mode: componentProps.mode,
          isAgentTurn: isAgentTurn(),
          selectedDeliveryMode: selectedDeliveryMode(),
        }}
      />
      {blockedByValidation() ? (
        <div class="cron-form-status" role="status" aria-live="polite">
          <div class="cron-form-status__title">{t("cron.form.cantAddYet")}</div>
          <div class="cron-help">{t("cron.form.fillRequired")}</div>
          <ul class="cron-form-status__list">
            {
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
            }
          </ul>
        </div>
      ) : undefined}
      {componentProps.props.canManage && !systemOwned() ? (
        <div class="cron-editor-actions">
          <button
            class="btn primary"
            data-test-id="cron-submit"
            disabled={componentProps.props.busy || !componentProps.props.canSubmit}
            onClick={() => componentProps.props.onSubmit()}
          >
            {componentProps.props.busy
              ? t("cron.form.saving")
              : componentProps.mode === "job"
                ? t("cron.form.saveChanges")
                : t("cron.form.createTask")}
          </button>
          {componentProps.mode === "create" ? (
            <button
              class="btn"
              data-test-id="cron-submit-run"
              disabled={componentProps.props.busy || !componentProps.props.canSubmit}
              onClick={() => componentProps.props.onSubmitRunNow()}
            >
              {t("cron.form.createAndRun")}
            </button>
          ) : undefined}
          <button
            class="btn"
            disabled={componentProps.props.busy}
            onClick={() => componentProps.props.onClosePanel()}
          >
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
  );
}
// Only the read-only payload kinds carry source text; the rest are prose prompts,
// so an empty language keeps them on the plain editable textarea.
const CRON_PAYLOAD_CODE_LANGUAGES: Record<CronFormState["payloadKind"], string> = {
  script: "javascript",
  command: "bash",
  heartbeat: "",
  systemEvent: "",
  agentTurn: "",
};
function PromptSection(componentProps: {
  props: CronProps;
  ctx: {
    payloadLocked: boolean;
    isAgentTurn: boolean;
  };
}) {
  const lockedPayloadLabel = createMemo(() =>
    componentProps.props.form.payloadKind === "script"
      ? t("cron.form.script")
      : componentProps.props.form.payloadKind === "heartbeat"
        ? "Heartbeat monitor"
        : componentProps.props.form.payloadKind === "agentTurn"
          ? t("cron.form.assistantTaskPrompt")
          : t("cron.form.command"),
  );
  const promptLabel = createMemo(() =>
    componentProps.ctx.payloadLocked
      ? lockedPayloadLabel()
      : componentProps.props.form.payloadKind === "systemEvent"
        ? t("cron.form.mainTimelineMessage")
        : t("cron.form.assistantTaskPrompt"),
  );
  const promptHelp = createMemo(() =>
    componentProps.ctx.payloadLocked
      ? t("cron.form.readOnlyPayloadHelp")
      : componentProps.props.form.payloadKind === "systemEvent"
        ? t("cron.form.systemEventHelp")
        : t("cron.form.agentTurnHelp"),
  );
  // Script/command payloads are always read-only here, so they render as a highlighted
  // code block instead of a textarea; every other kind stays an editable field. The code
  // block carries no aria-invalid/describedby because validateCronForm skips payloadText
  // for locked payloads, so this branch can never render a payload error.
  const codeLanguage = createMemo(() =>
    componentProps.ctx.payloadLocked
      ? CRON_PAYLOAD_CODE_LANGUAGES[componentProps.props.form.payloadKind]
      : "",
  );
  const payloadText = createMemo(() =>
    componentProps.props.form.payloadKind === "heartbeat"
      ? componentProps.props.heartbeatScratch
      : componentProps.props.form.payloadText,
  );
  const promptRow = (
    <FieldRow
      params={{
        label: promptLabel(),
        controlId: codeLanguage() ? "" : "cron-payload-text",
        required: true,
        help: promptHelp(),
        stacked: true,
        wide: true,
        error: componentProps.props.fieldErrors.payloadText,
        errorId: errorIdForField("payloadText"),
        control: codeLanguage() ? (
          <pre
            id="cron-payload-text"
            class="code-block cron-payload-code"
            data-test-id="cron-payload-code"
            tabIndex="0"
            role="region"
            aria-label={promptLabel()}
          >
            <LitContent
              tag="code"
              class="hljs"
              value={html`${unsafeHTML(highlightCodeHtml(payloadText(), codeLanguage()))}`}
            />
          </pre>
        ) : (
          <textarea
            id="cron-payload-text"
            class="settings-input"
            rows="6"
            prop:value={payloadText()}
            readOnly={componentProps.ctx.payloadLocked}
            aria-required="true"
            placeholder={t("cron.form.promptPlaceholder")}
            aria-invalid={componentProps.props.fieldErrors.payloadText ? "true" : "false"}
            aria-describedby={
              componentProps.props.fieldErrors.payloadText
                ? errorIdForField("payloadText")
                : undefined
            }
            onInput={(e) =>
              componentProps.props.onFormChange({
                payloadText: e.currentTarget.value,
              })
            }
          />
        ),
      }}
    />
  );
  const actionLabel = createMemo(() => t("cron.form.action"));
  const actionRow = createMemo(() =>
    componentProps.ctx.payloadLocked ? (
      <FieldRow
        params={{
          label: actionLabel(),
          controlId: inputIdForField("payloadKind"),
          control: (
            <input
              id={inputIdForField("payloadKind")}
              class="settings-input"
              prop:value={lockedPayloadLabel()}
              readOnly
            />
          ),
        }}
      />
    ) : (
      <CronSelect
        props={componentProps.props}
        field="payloadKind"
        options={{
          label: actionLabel(),
          options: [
            { value: "systemEvent", label: t("cron.form.systemEvent") },
            { value: "agentTurn", label: t("cron.form.agentTurn") },
          ],
        }}
      />
    ),
  );
  const modelLabel = createMemo(() => t("cron.form.model"));
  const modelError = createMemo(() => componentProps.props.fieldErrors.payloadModel);
  const modelOptions = createMemo(() =>
    uniqueStrings(componentProps.props.modelSuggestions).map((value) => {
      const provider = providerIdFromModelRef(value);
      return { value, label: value, provider: provider ?? undefined };
    }),
  );
  const agentTurnRows = createMemo(() =>
    componentProps.ctx.isAgentTurn ? (
      <>
        <FieldRow
          params={{
            label: modelLabel(),
            controlId: "",
            help: t("cron.form.modelHelp"),
            error: modelError(),
            errorId: errorIdForField("payloadModel"),
            control: (
              <CronModelPicker
                params={{
                  id: "cron-payload-model-picker",
                  label: modelLabel(),
                  value: componentProps.props.form.payloadModel,
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
                  onChange: (payloadModel) => componentProps.props.onFormChange({ payloadModel }),
                }}
              />
            ),
          }}
        />
        <CronInput
          props={componentProps.props}
          field="payloadThinking"
          options={{
            label: t("cron.form.thinking"),
            help: t("cron.form.thinkingHelp"),
            errorKey: "payloadThinking",
            describeError: false,
            list: "cron-thinking-suggestions",
            placeholder: t("cron.form.thinkingPlaceholder"),
          }}
        />
      </>
    ) : undefined,
  );
  return (
    <SettingsSection
      children={
        <>
          {" "}
          {promptRow}
          {actionRow()}
          {agentTurnRows()}{" "}
        </>
      }
    />
  );
}
function GeneralSection(props: CronProps) {
  const sessionTarget = createMemo(() => props.form.sessionTarget);
  const knownSessionTarget = createMemo(
    () => sessionTarget() === "main" || sessionTarget() === "isolated",
  );
  return (
    <SettingsSection
      title={t("cron.detail.generalSection")}
      children={
        <>
          <CronInput
            props={props}
            field="name"
            options={{
              label: t("cron.form.fieldName"),
              required: true,
              errorKey: "name",
              placeholder: t("cron.form.namePlaceholder"),
            }}
          />
          <CronInput
            props={props}
            field="agentId"
            options={{
              label: t("cron.form.agentId"),
              help: t("cron.form.agentHelp"),
              list: "cron-agent-suggestions",
              disabled: props.form.clearAgent,
              placeholder: t("cron.form.agentPlaceholder"),
            }}
          />
          <CronSelect
            props={props}
            field="sessionTarget"
            options={{
              label: t("cron.form.runsIn"),
              help: t("cron.form.sessionHelp"),
              options: [
                { value: "main", label: t("cron.form.mainSession") },
                { value: "isolated", label: t("cron.form.isolatedSession") },
                ...(knownSessionTarget()
                  ? []
                  : [{ value: sessionTarget(), label: sessionTarget() }]),
              ],
            }}
          />
        </>
      }
    />
  );
}
