import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { Picker } from "../../components/solid/select-picker.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { FieldRow, inputIdForField } from "./view-fields.tsx";
import type { CronProps } from "./view-types.ts";

export function CronAgentPicker(
  props: Pick<
    CronProps,
    | "form"
    | "editingJob"
    | "onFormChange"
    | "agentOptions"
    | "agentOptionsLoading"
    | "agentOptionsError"
    | "onLoadAgentOptions"
    | "busy"
    | "canManage"
  >,
) {
  let customInput: HTMLInputElement | undefined;
  const job = createMemo(() => props.editingJob?.id);
  // Keep an explicit custom edit through roster updates, but never carry it to another job.
  const [custom, setCustom] = createSignal(() => {
    job();
    return false;
  });
  const selected = () => (props.form.clearAgent ? "" : props.form.agentId.trim());
  const customValue = createMemo(() => {
    let value = "__custom_agent__";
    while (value === selected() || props.agentOptions.some((option) => option.value === value)) {
      value += "_";
    }
    return value;
  });
  const options = createMemo(() => {
    const rows = [...props.agentOptions];
    const current = selected();
    if (current && !rows.some((option) => option.value === current)) {
      rows.push({ value: current, label: current, description: t("cron.form.savedAgent") });
    }
    return [
      {
        value: "",
        label: t("cron.form.automaticAgent"),
        description: t("cron.form.automaticAgentHint"),
      },
      ...rows,
      { value: customValue(), label: t("cron.form.customAgent") },
    ];
  });
  const showSelectedDetail = createMemo(() => {
    const rows = options();
    const current = rows.find((option) => option.value === selected());
    return Boolean(
      current &&
      rows.some((option) => option.value !== current.value && option.label === current.label),
    );
  });
  const disabled = () => props.busy || !props.canManage;
  return (
    <FieldRow
      label={t("cron.form.agentId")}
      controlId={inputIdForField("agentId")}
      control={
        <>
          <Picker
            id={inputIdForField("agentId")}
            label={t("cron.form.agentId")}
            value={custom() ? customValue() : selected()}
            options={options()}
            disabled={disabled()}
            searchable="always"
            showSelectedDescription={showSelectedDetail()}
            onOpen={() => props.onLoadAgentOptions()}
            onChange={(value) => {
              if (value === customValue()) {
                setCustom(true);
                onSettled(() => {
                  customInput?.focus();
                  customInput?.select();
                });
              } else {
                setCustom(false);
                props.onFormChange({
                  agentId: value,
                  clearAgent: !value && Boolean(props.editingJob),
                });
              }
            }}
          />
          <Show when={custom()}>
            <input
              ref={(element) => (customInput = element)}
              class="settings-input"
              aria-label={t("cron.form.customAgentId")}
              value={props.form.agentId}
              disabled={disabled()}
              onInput={(event) => {
                const agentId = event.currentTarget.value;
                props.onFormChange({
                  agentId,
                  clearAgent: !agentId.trim() && Boolean(props.editingJob),
                });
              }}
              onBlur={() => {
                if (!props.form.agentId.trim()) {
                  setCustom(false);
                }
              }}
            />
          </Show>
          <Show when={props.agentOptionsLoading}>
            <span class="cron-help" role="status">
              {t("common.loading")}
            </span>
          </Show>
          <Show when={props.agentOptionsError}>
            <span class="cron-help" role="alert">
              {t("cron.form.agentsLoadFailed")}{" "}
              <button
                type="button"
                class="btn btn--sm"
                disabled={props.agentOptionsLoading || disabled()}
                onClick={() => props.onLoadAgentOptions()}
              >
                {t("common.retry")}
              </button>
            </span>
          </Show>
          <Show
            when={
              !props.agentOptionsLoading &&
              !props.agentOptionsError &&
              props.agentOptions.length === 0
            }
          >
            <span class="cron-help" role="status">
              {t("cron.form.noAgents")}
            </span>
          </Show>
        </>
      }
    />
  );
}
