import { createMemo, createSignal, Show } from "solid-js";
import { hasExplicitCronDeliveryTarget } from "../../../../src/cron/delivery-target-validation.js";
import { Picker } from "../../components/solid/select-picker.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  SESSION_SEARCH_SCOPE,
  SESSIONS_PAGE_DEFAULT_LIMIT,
} from "../../lib/sessions/session-requests.ts";
import { CronSelect, FieldRow } from "./view-fields.tsx";
import type { CronPanelMode, CronProps } from "./view-types.ts";

export function ConversationFields(props: CronProps & { mode: CronPanelMode }) {
  const [search, setSearch] = createSignal("");
  const form = () => props.form;
  const canContinue = createMemo(() => form().payloadKind === "agentTurn");
  // The Gateway captures the implicit delivery destination when the job is created.
  // An update to its public sessionKey cannot redirect that binding.
  const canChooseReport = createMemo(
    () =>
      props.mode === "create" &&
      props.canLinkReport &&
      form().sessionTarget !== "main" &&
      form().sessionTarget !== "current" &&
      (canContinue() || form().payloadLocked) &&
      (form().deliveryMode === "none" || form().deliveryMode === "announce") &&
      !hasExplicitCronDeliveryTarget({
        target: form().deliveryTarget || undefined,
        channel: form().deliveryChannel,
        to: form().deliveryTo.trim(),
        accountId: form().deliveryAccountId.trim(),
        threadId: form().deliveryThreadId,
      }),
  );
  const sessions = createMemo(() => (props.connected ? props.sessions : undefined));
  const effectiveAgentId = createMemo(() => props.conversationAgentId);
  const includeGlobal = createMemo(() => props.agentsList?.scope === "global");
  const directory = createMemo(
    () => {
      const roster = sessions();
      const agentId = effectiveAgentId();
      if (!roster || !agentId || (!canContinue() && !canChooseReport())) {
        return null;
      }
      return roster
        .list({
          ...SESSION_SEARCH_SCOPE,
          agentId,
          includeGlobal: includeGlobal(),
          includeDerivedTitles: true,
          rowMode: "compact",
          search: search().trim(),
          limit: SESSIONS_PAGE_DEFAULT_LIMIT,
        })
        .then(
          (result) => ({ result, failed: false }),
          () => ({ result: null, failed: true }),
        );
    },
    { loadingValue: null },
  );
  const conversations = createMemo(() =>
    (directory()?.result?.sessions ?? []).map((row) => ({
      value: row.key,
      label: resolveSessionDisplayName(row.key, row),
    })),
  );
  const target = createMemo(() => form().sessionTarget);
  const executionKey = createMemo(() => (target().startsWith("session:") ? target().slice(8) : ""));
  const linkedKey = createMemo(() => form().sessionKey);
  const knownNames = createMemo(
    () => {
      const roster = sessions();
      const rows = conversations();
      const keys = new Set(
        [executionKey(), linkedKey()].filter(
          (key) => key && !rows.some((row) => row.value === key),
        ),
      );
      if (!roster || !keys.size) {
        return null;
      }
      const agentId = effectiveAgentId();
      return Promise.all(
        [...keys].map(async (key) => {
          const details = await roster
            .describe({ key, agentId, includeDerivedTitles: true })
            .catch(() => null);
          return [
            key,
            details?.session ? resolveSessionDisplayName(key, details.session) : key,
          ] as const;
        }),
      ).then((entries) => new Map(entries));
    },
    { lazy: true, loadingValue: null },
  );
  const choices = (selected: string) => {
    const rows = conversations();
    const options =
      selected && !rows.some((row) => row.value === selected)
        ? [
            {
              value: selected,
              label: knownNames()?.get(selected) ?? selected,
            },
            ...rows,
          ]
        : rows;
    const byName = Map.groupBy(options, (row) => row.label);
    return options.map(({ value, label }) => ({
      value: `session:${value}`,
      label,
      description: byName.get(label)!.length > 1 ? value : undefined,
    }));
  };
  const executionOptions = createMemo(() => [
    ...(form().payloadKind === "command"
      ? []
      : [{ value: "main", label: t("cron.form.mainSession") }]),
    { value: "isolated", label: t("cron.form.isolatedSession") },
    ...(target() === "current" || (canContinue() && form().sessionKey)
      ? [{ value: "current", label: t("cron.form.currentSession") }]
      : []),
    ...(canContinue() || target().startsWith("session:") ? choices(executionKey()) : []),
  ]);
  const choosesSource = () => props.mode === "create" && target() === "current";
  const chatFieldLabel = () =>
    t(choosesSource() ? "cron.form.recentChatSource" : "cron.form.reportTo");
  return (
    <>
      <Show when={directory()?.result?.hasMore || directory()?.failed || search()}>
        <input
          type="search"
          class="settings-input"
          aria-label={t("cron.form.searchConversations")}
          placeholder={t("cron.form.searchConversations")}
          value={search()}
          onInput={(event) => setSearch(event.currentTarget.value)}
        />
      </Show>
      <Show when={directory()?.failed}>
        <span role="status">{t("cron.form.conversationSearchFailed")}</span>
      </Show>
      <CronSelect
        {...props}
        field="sessionTarget"
        label={t("cron.form.runsIn")}
        help={t("cron.form.sessionHelp")}
        quietHelp
        options={executionOptions()}
      />
      <Show
        when={
          choosesSource() ||
          (canChooseReport() && (conversations().length || linkedKey() || search()))
        }
      >
        <FieldRow
          label={chatFieldLabel()}
          controlId="cron-report-to"
          help={t(choosesSource() ? "cron.form.recentChatSourceHelp" : "cron.form.reportToHelp")}
          control={
            <Picker
              id="cron-report-to"
              label={chatFieldLabel()}
              value={
                !choosesSource() && form().deliveryMode === "none"
                  ? "none"
                  : `session:${linkedKey()}`
              }
              options={[
                ...(choosesSource()
                  ? []
                  : [
                      { value: "none", label: t("cron.form.noneInternal") },
                      { value: "session:", label: t("cron.form.defaultDestination") },
                    ]),
                ...choices(form().sessionKey),
              ]}
              onChange={(value) =>
                props.onFormChange(
                  choosesSource()
                    ? { sessionKey: value.slice(8) }
                    : value === "none"
                      ? { deliveryMode: "none", sessionKey: "" }
                      : { deliveryMode: "announce", sessionKey: value.slice(8) },
                )
              }
            />
          }
        />
      </Show>
    </>
  );
}
