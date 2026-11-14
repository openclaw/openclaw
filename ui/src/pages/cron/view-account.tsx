import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { Picker } from "../../components/solid/select-picker.tsx";
import { resolveChannelAccounts } from "../../lib/channels/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { CronInput, FieldRow, inputIdForField } from "./view-fields.tsx";
import type { CronProps } from "./view-types.ts";

type AccountField = "deliveryAccountId" | "failureAlertAccountId";
export function CronAccountPicker(
  props: Pick<
    CronProps,
    | "form"
    | "editingJob"
    | "onFormChange"
    | "fieldErrors"
    | "accountCatalog"
    | "onRetryAccountCatalog"
    | "busy"
    | "canManage"
    | "connected"
  > & { field: AccountField; channel: string },
) {
  let input: HTMLInputElement | undefined;
  const scope = createMemo(() => [props.field, props.channel, props.editingJob?.id] as const, {
    equals: (previous, next) => previous.every((value, index) => value === next[index]),
  });
  // The form owner keeps values; only the custom-entry presentation follows the field scope.
  const [custom, setCustom] = createSignal(() => {
    scope();
    return false;
  });
  const label = () =>
    t(
      props.field === "deliveryAccountId"
        ? "cron.form.accountId"
        : "cron.form.failureAlertAccountId",
    );
  const selected = () => props.form[props.field].trim();
  const channel = () => props.channel.trim() || "last";
  const accounts = createMemo(() =>
    resolveChannelAccounts(props.accountCatalog.accounts, channel()),
  );
  const customValue = createMemo(() => {
    let value = "__custom_account__";
    while (value === selected() || accounts().some((account) => account.accountId === value)) {
      value += "_";
    }
    return value;
  });
  const options = createMemo(() => {
    const rows = accounts().map((account) => ({
      value: account.accountId,
      label: account.name?.trim() || account.accountId,
      description: account.accountId,
    }));
    const current = selected();
    if (current && !rows.some((option) => option.value === current)) {
      rows.push({ value: current, label: current, description: t("cron.form.accountReference") });
    }
    return [
      {
        value: "",
        label: t("cron.form.automaticAccount"),
        description: t("cron.form.automaticAccountHint"),
      },
      ...rows,
      { value: customValue(), label: t("cron.form.customAccount"), description: "" },
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
    <Show
      when={channel() !== "last"}
      fallback={
        <CronInput
          {...props}
          field={props.field}
          label={label()}
          help={t("cron.form.accountIdHelp")}
          list={
            props.field === "deliveryAccountId" ? "cron-delivery-account-suggestions" : undefined
          }
          placeholder={t("cron.form.automaticAccount")}
        />
      }
    >
      <FieldRow
        label={label()}
        controlId={inputIdForField(props.field)}
        control={
          <>
            <Picker
              id={inputIdForField(props.field)}
              label={label()}
              value={custom() ? customValue() : selected()}
              options={options()}
              disabled={disabled()}
              searchable="always"
              showSelectedDescription={showSelectedDetail()}
              onChange={(value) => {
                if (value === customValue()) {
                  setCustom(true);
                  onSettled(() => {
                    input?.focus();
                    input?.select();
                  });
                } else {
                  setCustom(false);
                  props.onFormChange({ [props.field]: value });
                }
              }}
            />
            <Show when={custom()}>
              <input
                class="settings-input"
                ref={(element) => (input = element)}
                aria-label={t(
                  props.field === "deliveryAccountId"
                    ? "cron.form.customAccountId"
                    : "cron.form.customAlertAccountId",
                )}
                value={props.form[props.field]}
                disabled={disabled()}
                onInput={(event) =>
                  props.onFormChange({ [props.field]: event.currentTarget.value })
                }
                onBlur={() => {
                  if (!props.form[props.field].trim()) {
                    setCustom(false);
                  }
                }}
              />
            </Show>
            <Show when={props.accountCatalog.loading}>
              <span class="cron-help" role="status">
                {t("common.loading")}
              </span>
            </Show>
            <Show when={props.accountCatalog.error}>
              <span class="cron-help" role="alert">
                {formatUiExternalText(props.accountCatalog.error)}{" "}
                <button
                  class="btn btn--sm"
                  type="button"
                  disabled={props.accountCatalog.loading || !props.connected || disabled()}
                  onClick={() => props.onRetryAccountCatalog()}
                >
                  {t("common.retry")}
                </button>
              </span>
            </Show>
            <Show
              when={
                !props.accountCatalog.loading &&
                !props.accountCatalog.error &&
                accounts().length === 0
              }
            >
              <span class="cron-help" role="status">
                {t(
                  props.accountCatalog.accounts
                    ? "cron.form.noAccountChoices"
                    : "cron.form.accountChoicesUnavailable",
                )}
              </span>
            </Show>
          </>
        }
      />
    </Show>
  );
}
