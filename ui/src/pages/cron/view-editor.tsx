import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { createMemo, For, Show } from "solid-js";
import type { AgentSelectOption } from "../../components/agent-select-types.ts";
import "../../components/agent-select-registration.ts";
import { highlightCodeHtml } from "../../components/markdown-code-blocks.ts";
import { providerIdFromModelRef } from "../../components/provider-icon-data.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { ModelPicker } from "../../components/solid/model-picker.tsx";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import { registerPreferencesEnglish } from "../../i18n/locales/en-preferences.ts";
import { listSelectableAgents, normalizeAgentLabel } from "../../lib/agents/display.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { CronScratchEditor } from "./scratch-editor.tsx";
import { EnabledSwitch } from "./view-controls.tsx";
import { Advanced } from "./view-delivery.tsx";
import {
  collectBlockingFields,
  focusFormField,
  errorIdForField,
  inputIdForField,
  CronSelect,
  FieldRow,
  TrayInput,
} from "./view-fields.tsx";
import {
  ScheduleControls,
  ScheduleDetails,
  ScheduleNote,
  TRAY_SCHEDULE_FIELDS,
  TrayErrors,
} from "./view-schedule.tsx";
import type { CronProps, CronPanelMode } from "./view-types.ts";

registerEnglishCatalog(registerPreferencesEnglish);

type EditorProps = CronProps & {
  mode: CronPanelMode;
};

function payloadFacts(props: CronProps) {
  const payloadLocked = () => props.form.payloadLocked;
  const isAgentTurn = () => !payloadLocked() && props.form.payloadKind === "agentTurn";
  return { payloadLocked, isAgentTurn, selectedDeliveryMode: () => props.form.deliveryMode };
}

/** Why the save button is disabled, and which fields block it. */
function createSubmitState(props: CronProps) {
  const { selectedDeliveryMode } = payloadFacts(props);
  const blockingFields = createMemo(() =>
    collectBlockingFields(props.fieldErrors, selectedDeliveryMode()),
  );
  const blockedByValidation = () => props.canManage && !props.busy && blockingFields().length > 0;
  const submitDisabledReason = () =>
    blockedByValidation() && !props.canSubmit
      ? blockingFields().length === 1
        ? t("cron.form.fixFields", { count: String(blockingFields().length) })
        : t("cron.form.fixFieldsPlural", { count: String(blockingFields().length) })
      : "";
  return { blockingFields, blockedByValidation, submitDisabledReason };
}

/** Save or create, with Cancel. Edit puts these in the header; create ends the form with them. */
export function EditorActions(props: EditorProps & { onCancel: () => void }) {
  const { submitDisabledReason } = createSubmitState(props);
  return (
    <div class={["cron-editor-actions", `cron-editor-actions--${props.mode}`]}>
      {submitDisabledReason() ? (
        <div class="cron-submit-reason" aria-live="polite">
          {submitDisabledReason()}
        </div>
      ) : undefined}
      <button
        type="button"
        class="btn btn--ghost"
        data-test-id="cron-cancel"
        disabled={props.busy}
        onClick={() => props.onCancel()}
      >
        {t("cron.form.cancel")}
      </button>
      {props.canManage ? (
        <>
          <button
            type="button"
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
        </>
      ) : undefined}
    </div>
  );
}

export function Editor(props: EditorProps & { phoneLayout: boolean }) {
  const { payloadLocked, isAgentTurn, selectedDeliveryMode } = payloadFacts(props);
  const { blockingFields, blockedByValidation } = createSubmitState(props);
  const sessionTarget = () => props.form.sessionTarget;
  const knownSessionTarget = () => sessionTarget() === "isolated";
  const formDisabled = () => props.busy || !props.canManage;
  const editableJob = () =>
    props.mode === "job" && props.phoneLayout && props.canManage ? props.editingJob : undefined;
  return (
    <>
      <div class="cron-editor-layout">
        <fieldset
          class="cron-editor"
          disabled={formDisabled()}
          aria-busy={props.busy ? "true" : "false"}
        >
          <PromptBlock
            {...props}
            payloadLocked={payloadLocked()}
            isAgentTurn={isAgentTurn()}
            phoneLayout={props.phoneLayout}
          />
          <ScheduleDetails {...props} />
        </fieldset>
        <div class="settings-group cron-editor-card cron-editor-placement">
          <Show when={editableJob()} keyed>
            {(job) => (
              <div class="settings-row cron-editor-active">
                <span class="settings-row__title">{t("cron.detail.active")}</span>
                <EnabledSwitch {...props} job={job} />
              </div>
            )}
          </Show>
          <fieldset class="cron-editor-section" disabled={formDisabled()}>
            <AgentRow {...props} disabled={formDisabled()} />
            <CronSelect
              {...props}
              field="sessionTarget"
              label={t("cron.form.runsIn")}
              help={t("cron.form.sessionHelp")}
              quietHelp
              options={[
                { value: "isolated", label: t("cron.form.isolatedSession") },
                ...(knownSessionTarget()
                  ? []
                  : [{ value: sessionTarget(), label: sessionTarget() }]),
              ]}
            />
          </fieldset>
        </div>
        <fieldset class="cron-editor-section cron-editor-extra" disabled={formDisabled()}>
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
        </fieldset>
      </div>
      {props.editingJob && props.canManage ? (
        <CronScratchEditor
          jobId={props.editingJob.id}
          gateway={props.gateway}
          getRetired={props.getActionRetired}
        />
      ) : undefined}
      {props.mode === "create" && props.canManage ? (
        <EditorActions {...props} onCancel={() => props.onClosePanel()} />
      ) : props.mode === "job" && props.phoneLayout && props.editingJob ? (
        <EditorActions {...props} onCancel={() => props.onCancelEdit()} />
      ) : undefined}
    </>
  );
}

/**
 * Which agent runs the automation. An empty id (or a cleared one) leaves the choice to the
 * Gateway, which falls back to its default agent; a stored id missing from the roster is kept
 * until another agent is picked.
 */
function AgentRow(props: CronProps & { disabled: boolean }) {
  // Typing elsewhere in the form replaces it; only the agent fields rebuild the options.
  const stored = createMemo(() => (props.form.clearAgent ? "" : props.form.agentId.trim()));
  const choice = createMemo(() => {
    const list = props.agentsList;
    const agents = listSelectableAgents(list?.agents ?? []);
    const byId = new Map(agents.map((agent) => [normalizeAgentId(agent.id), agent]));
    const value = stored() ? normalizeAgentId(stored()) : "";
    const unlisted = Boolean(list && value && !byId.has(value));
    // System agents are not offered, but a job they own still names them.
    const system = list?.agents.find((agent) => normalizeAgentId(agent.id) === value);
    const options: AgentSelectOption[] = [
      // Cron can inherit an owner from the session key or Gateway configuration.
      { value: "", label: t("cron.form.defaultAgent") },
      ...[...byId].map(([id, agent]) => ({ value: id, label: normalizeAgentLabel(agent), agent })),
      ...(unlisted
        ? [
            system
              ? { value, label: normalizeAgentLabel(system), agent: system }
              : {
                  value,
                  label: stored(),
                  agent: { id: value },
                  badge: t("cron.form.agentNotFound"),
                },
          ]
        : []),
    ];
    // An existing override can be cleared even if there is only one selectable agent.
    const hasOverride = Boolean(props.editingJob?.agentId?.trim());
    return {
      options,
      value,
      visible: Boolean(list) && (agents.length !== 1 || unlisted || hasOverride),
    };
  });
  return (
    <Show when={choice().visible}>
      <FieldRow
        label={t("cron.form.agentId")}
        controlId=""
        control={
          <openclaw-agent-select
            prop:options={choice().options}
            prop:value={choice().value}
            prop:accessibleLabel={t("cron.form.agentId")}
            prop:disabled={props.disabled}
            prop:onSelect={(agentId: string) =>
              props.onFormChange({ agentId, clearAgent: agentId === "" })
            }
          />
        }
      />
    </Show>
  );
}

/**
 * The automation as one composer: name and prompt on the sheet, and when and how it runs on
 * the tray tucked under it.
 */
function PromptBlock(
  props: CronProps & {
    payloadLocked: boolean;
    isAgentTurn: boolean;
    phoneLayout: boolean;
  },
) {
  const lockedPayloadLabel = () =>
    props.form.payloadKind === "script" ? t("cron.form.script") : t("cron.form.command");
  const promptLabel = () =>
    props.payloadLocked ? lockedPayloadLabel() : t("cron.form.assistantTaskPrompt");
  const promptHelp = () =>
    props.payloadLocked ? t("cron.form.readOnlyPayloadHelp") : t("cron.form.agentTurnHelp");
  const modelError = () => props.fieldErrors.payloadModel;
  const modelOptions = createMemo(() =>
    uniqueStrings(props.modelSuggestions).map((value) => {
      const provider = providerIdFromModelRef(value);
      return { value, label: value, provider: provider ?? undefined };
    }),
  );
  const nameError = () => props.fieldErrors.name;
  const payloadError = () => props.fieldErrors.payloadText;
  return (
    <div class="cron-prompt cron-prompt--editing">
      <div class="cron-prompt__sheet">
        <textarea
          id={inputIdForField("name")}
          class="cron-prompt__name"
          rows="1"
          value={props.form.name}
          aria-label={t("cron.form.fieldName")}
          aria-required="true"
          aria-invalid={nameError() ? "true" : "false"}
          aria-describedby={nameError() ? errorIdForField("name") : undefined}
          placeholder={t("cron.form.namePlaceholder")}
          onKeyDown={(event) => {
            // The name is one line that wraps, as the single-line field it replaces.
            if (event.key === "Enter" && !event.isComposing) {
              event.preventDefault();
            }
          }}
          onInput={(event) =>
            props.onFormChange({ name: event.currentTarget.value.replace(/[\r\n]+/g, "") })
          }
        />
        {nameError() ? (
          <div id={errorIdForField("name")} class="cron-help cron-error" role="alert">
            {t(nameError() ?? "")}
          </div>
        ) : undefined}
        {props.payloadLocked ? (
          <>
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
                html={highlightCodeHtml(
                  props.form.payloadText,
                  props.form.payloadKind === "script" ? "javascript" : "bash",
                )}
              />
            </pre>
            <div class="cron-help cron-prompt__note">{promptHelp()}</div>
          </>
        ) : (
          <>
            <textarea
              id="cron-payload-text"
              class="cron-prompt__text"
              rows="3"
              value={props.form.payloadText}
              aria-label={promptLabel()}
              aria-required="true"
              placeholder={t("cron.form.promptPlaceholder")}
              aria-invalid={payloadError() ? "true" : "false"}
              aria-describedby={[
                "cron-payload-text-help",
                payloadError() ? errorIdForField("payloadText") : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onInput={(e) =>
                props.onFormChange({
                  payloadText: e.currentTarget.value,
                })
              }
            />
            <span id="cron-payload-text-help" class="sr-only">
              {promptHelp()}
            </span>
          </>
        )}
        {payloadError() ? (
          <div id={errorIdForField("payloadText")} class="cron-help cron-error" role="alert">
            {t(payloadError() ?? "")}
          </div>
        ) : undefined}
      </div>
      <div class="cron-prompt__tray">
        <div class="cron-prompt__controls">
          <span class="cron-prompt__clock" aria-hidden="true">
            <Icon name="clock" />
          </span>
          <div class="cron-editor-schedule">
            <ScheduleControls {...props} phoneLayout={props.phoneLayout} />
            <ScheduleNote {...props} />
          </div>
          {props.isAgentTurn ? (
            <span class="cron-prompt__run-controls">
              <span class="cron-tray-picker" title={t("cron.form.modelHelp")}>
                <ModelPicker
                  id="cron-payload-model-picker"
                  label={t("cron.form.model")}
                  value={props.form.payloadModel}
                  options={[
                    { value: "", label: t("quickSettings.model.default") },
                    ...modelOptions(),
                  ]}
                  custom={{
                    id: inputIdForField("payloadModel"),
                    label: t("cron.form.customModel"),
                    placeholder: t("cron.form.modelPlaceholder"),
                    invalid: Boolean(modelError()),
                    describedBy: modelError() ? errorIdForField("payloadModel") : undefined,
                  }}
                  onChange={(payloadModel) => props.onFormChange({ payloadModel })}
                />
              </span>
              <TrayInput
                {...props}
                field="payloadThinking"
                label={t("cron.form.thinking")}
                help={t("cron.form.thinkingHelp")}
                errorKey="payloadThinking"
                size="narrow"
                list="cron-thinking-suggestions"
                placeholder={t("cron.form.thinkingPlaceholder")}
              />
            </span>
          ) : undefined}
        </div>
        <div class="cron-editor-tray-errors">
          <TrayErrors
            fieldErrors={props.fieldErrors}
            fields={[...TRAY_SCHEDULE_FIELDS, "payloadModel", "payloadThinking"]}
          />
        </div>
      </div>
    </div>
  );
}
