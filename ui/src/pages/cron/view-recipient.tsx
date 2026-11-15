import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { Picker } from "../../components/solid/select-picker.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { CronInput, FieldRow, inputIdForField } from "./view-fields.tsx";
import type { CronProps } from "./view-types.ts";

export function CronRecipientPicker(
  props: Pick<
    CronProps,
    | "form"
    | "editingJob"
    | "deliveryConversations"
    | "busy"
    | "canManage"
    | "onFormChange"
    | "fieldErrors"
  >,
) {
  let input: HTMLInputElement | undefined;
  const scope = createMemo(
    () =>
      [
        props.editingJob?.id,
        props.form.agentId,
        props.form.deliveryChannel,
        props.form.deliveryAccountId,
      ] as const,
    { equals: (a, b) => a.every((value, index) => value === b[index]) },
  );
  const [custom, setCustom] = createSignal(() => {
    scope();
    return false;
  });
  const scoped = () =>
    Boolean(
      props.form.deliveryAccountId.trim() &&
      props.form.deliveryChannel &&
      props.form.deliveryChannel !== "last",
    );
  // A partial directory supplies explicit route choices, never inferred account or topic defaults.
  const choices = createMemo(() =>
    props.deliveryConversations.filter(
      (row) =>
        row.accountId === props.form.deliveryAccountId.trim() &&
        row.channel === props.form.deliveryChannel,
    ),
  );
  const current = () => props.form.deliveryTo.trim();
  const selected = createMemo(() =>
    choices().find(
      (row) =>
        row.target === current() &&
        (row.threadId ?? "") === String(props.form.deliveryThreadId ?? ""),
    ),
  );
  const detail = (target: string, threadId?: string | number) =>
    threadId === undefined
      ? target
      : t(target ? "cron.form.recipientThread" : "cron.form.recipientThreadOnly", {
          target,
          thread: String(threadId),
        });
  const options = createMemo(() => [
    {
      value: "",
      label: t("cron.form.noRecipientOverride"),
      description:
        !current() && props.form.deliveryThreadId !== undefined
          ? detail("", props.form.deliveryThreadId)
          : undefined,
    },
    ...choices().map((row) => ({
      value: row.conversationRef,
      label: row.label?.trim() || row.target,
      description: detail(row.target, row.threadId),
    })),
    ...(current() && !selected()
      ? [
          {
            value: "saved",
            label: current(),
            description:
              props.form.deliveryThreadId === undefined
                ? undefined
                : detail("", props.form.deliveryThreadId),
          },
        ]
      : []),
    { value: "custom", label: t("cron.form.enterRecipient") },
  ]);
  const disabled = () => props.busy || !props.canManage;
  return (
    <Show
      when={scoped()}
      fallback={
        <CronInput
          {...props}
          field="deliveryTo"
          label={t("cron.form.to")}
          help={t("cron.form.toHelp")}
          list="cron-delivery-to-suggestions"
          placeholder={t("cron.form.toPlaceholder")}
        />
      }
    >
      <FieldRow
        label={t("cron.form.to")}
        controlId={inputIdForField("deliveryTo")}
        help={t("cron.form.knownRecipientsHelp")}
        control={
          <>
            <Picker
              id={inputIdForField("deliveryTo")}
              label={t("cron.form.to")}
              value={
                custom() ? "custom" : !current() ? "" : (selected()?.conversationRef ?? "saved")
              }
              options={options()}
              searchable="always"
              showSelectedDescription
              disabled={disabled()}
              onChange={(value) => {
                if (value === "custom") {
                  setCustom(true);
                  onSettled(() => {
                    input?.focus();
                    input?.select();
                  });
                  return;
                }
                setCustom(false);
                if (value === "") {
                  props.onFormChange({ deliveryTo: "", deliveryThreadId: undefined });
                  return;
                }
                const row = choices().find((entry) => entry.conversationRef === value);
                if (row) {
                  props.onFormChange({ deliveryTo: row.target, deliveryThreadId: row.threadId });
                }
              }}
            />
            <Show when={custom()}>
              <input
                ref={(element) => (input = element)}
                class="settings-input"
                aria-label={t("cron.form.customRecipient")}
                value={props.form.deliveryTo}
                disabled={disabled()}
                list="cron-delivery-to-suggestions"
                onInput={(event) => props.onFormChange({ deliveryTo: event.currentTarget.value })}
              />
            </Show>
          </>
        }
      />
    </Show>
  );
}
