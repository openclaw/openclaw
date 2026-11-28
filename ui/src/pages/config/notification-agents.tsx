import { createMemo, createSignal, For, Show } from "solid-js";
import type { WebPushAgentSelection } from "../../app/web-push.runtime.ts";
import { ModalDialog } from "../../components/modal-dialog.tsx";
import { Checkbox } from "../../components/solid/checkbox.tsx";
import { DialogHeader } from "../../components/solid/dialog-header.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { SettingsRow } from "../../components/solid/settings-ui.tsx";
import { normalizeAgentLabel } from "../../lib/agents/display.ts";
import type { AgentCapability } from "../../lib/agents/index.ts";
import { t } from "../../lib/reactive/i18n.ts";

export type NotificationAgentCatalog = Pick<
  AgentCapability["state"],
  "agentsList" | "agentsLoading" | "agentsError"
>;
export type NotificationAgentOptions = {
  agentCatalog?: NotificationAgentCatalog;
  onLoadAgents?: () => void;
  presentationScope?: Promise<void>;
  writePending?: boolean;
  submission?: WebPushAgentSelection;
};
type Selection = { mode: "inherit" | "all" | "specific"; ids: string[] };
type AgentRowProps = NotificationAgentOptions & {
  agentIds: string[] | undefined;
  inheritedAgentIds?: string[];
  inherit?: boolean;
  disabled?: boolean;
  onChange: (ids: string[] | undefined) => Promise<void> | void;
};

export function NotificationAgentsRow(props: AgentRowProps) {
  const scope = createMemo(() => ({ retired: props.presentationScope }), {
    equals: (previous, next) => previous.retired === next.retired,
  });
  // A new page/connection lifetime must not carry a selection into another target.
  const [draft, setDraft] = createSignal<Selection | undefined>(() => {
    scope();
    return undefined;
  });
  const submit = (selection: Selection) => {
    setDraft(undefined);
    // The command owner publishes both the failure and the selection to retry.
    void Promise.resolve(
      props.onChange(
        selection.mode === "inherit" ? undefined : selection.mode === "all" ? [] : selection.ids,
      ),
    ).catch(() => {});
  };
  const displayedIds = () =>
    props.submission?.state === "pending" ? props.submission.agentIds : props.agentIds;
  const summary = createMemo(() => {
    const ids = displayedIds() ?? props.inheritedAgentIds ?? [];
    const agents = props.agentCatalog?.agentsList?.agents;
    const selected = ids.map((id) => {
      const agent = agents?.find((entry) => entry.id === id);
      const name = agent ? normalizeAgentLabel(agent) : id;
      const duplicate = agents?.some(
        (entry) => entry.id !== id && normalizeAgentLabel(entry) === name,
      );
      return { name, full: duplicate ? `${name} (${id})` : name };
    });
    const full =
      selected.map((agent) => agent.full).join(", ") || t("configView.notifications.allAgents");
    const compact =
      selected.length > 1
        ? t("configView.notifications.agentsSelected", { count: String(selected.length) })
        : (selected[0]?.name ?? full);
    const scoped = (names: string) =>
      displayedIds() === undefined
        ? t("configView.notifications.inheritAgents", { agents: names })
        : names;
    return { full: scoped(full), compact: scoped(compact) };
  });
  return (
    <>
      <SettingsRow
        title={t("configView.notifications.agents")}
        description={
          <Show when={props.submission}>
            {(attempt) => (
              <span role="status">
                {t(
                  attempt().state === "pending"
                    ? "common.saving"
                    : "configView.notifications.retryAgentSelection",
                )}
              </span>
            )}
          </Show>
        }
        control={
          <button
            type="button"
            class="btn notification-agents__trigger"
            disabled={props.disabled}
            aria-label={t("configView.notifications.chooseAgents")}
            aria-description={summary().full}
            title={summary().full}
            onClick={() => {
              const ids = props.submission ? props.submission.agentIds : props.agentIds;
              setDraft({
                mode: ids === undefined ? "inherit" : ids.length ? "specific" : "all",
                ids: ids ?? [],
              });
              props.onLoadAgents?.();
            }}
          >
            <span>{summary().compact}</span>
            <Icon name="chevronDown" />
          </button>
        }
      />
      <Show when={draft()}>
        {(selection) => (
          <AgentSelectionDialog
            {...props}
            selection={selection()}
            onSave={submit}
            onDraft={setDraft}
            onClose={() => setDraft(undefined)}
          />
        )}
      </Show>
    </>
  );
}

function AgentSelectionDialog(
  props: AgentRowProps & {
    selection: Selection;
    onDraft: (selection: Selection) => void;
    onSave: (selection: Selection) => void;
    onClose: () => void;
  },
) {
  const [query, setQuery] = createSignal("");
  // Keep unresolved saved IDs visible; absence from the authorized roster is not deletion.
  const rows = createMemo(() => {
    const agents = props.agentCatalog?.agentsList?.agents ?? [];
    const options = agents.map((agent) => ({
      id: agent.id,
      name: normalizeAgentLabel(agent),
      available: true,
    }));
    for (const id of new Set([...(props.agentIds ?? []), ...props.selection.ids])) {
      if (!agents.some((agent) => agent.id === id)) {
        options.push({ id, name: id, available: false });
      }
    }
    const search = query().trim().toLocaleLowerCase();
    return options.filter(
      (agent) =>
        !search ||
        [agent.name, agent.id].some((value) => value.toLocaleLowerCase().includes(search)),
    );
  });
  const blocked = () =>
    props.disabled ||
    props.writePending ||
    (props.selection.mode === "specific" && props.selection.ids.length === 0);
  return (
    <ModalDialog
      open
      label={t("configView.notifications.chooseAgents")}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <form
        class="oc-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!blocked()) {
            props.onSave(props.selection);
          }
        }}
      >
        <DialogHeader
          title={t("configView.notifications.chooseAgents")}
          description={t(
            props.inherit
              ? "configView.notifications.installedApp"
              : "configView.notifications.accountDefaults",
          )}
          onClose={() => props.onClose()}
        />
        <div class="oc-dialog__body">
          <SettingsSelect
            aria-label={t("configView.notifications.agentScope")}
            disabled={props.disabled}
            value={props.selection.mode}
            options={[
              ...(props.inherit
                ? [{ value: "inherit", label: t("configView.notifications.inherit") }]
                : []),
              { value: "all", label: t("configView.notifications.allAgents") },
              { value: "specific", label: t("configView.notifications.specificAgents") },
            ]}
            onChange={(event) => {
              const mode = event.currentTarget.value;
              if (mode === "inherit" || mode === "all" || mode === "specific") {
                props.onDraft({ ...props.selection, mode });
              }
            }}
          />
          <Show when={props.selection.mode === "all"}>
            <p class="muted">{t("configView.notifications.allAgentsHint")}</p>
          </Show>
          <Show when={props.selection.mode === "inherit"}>
            <p class="muted">{t("configView.notifications.inheritAgentsHint")}</p>
          </Show>
          <Show when={props.selection.mode === "specific"}>
            <input
              class="settings-input"
              type="search"
              aria-label={t("configView.notifications.searchAgents")}
              placeholder={t("configView.notifications.searchAgents")}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            <div>
              <For each={rows()} keyed={(row) => row.id}>
                {(row) => (
                  <label class="settings-row notification-agents__option">
                    <Checkbox
                      checked={props.selection.ids.includes(row().id)}
                      disabled={
                        props.disabled ||
                        (!props.selection.ids.includes(row().id) &&
                          props.selection.ids.length >= 128)
                      }
                      onChange={(event) =>
                        props.onDraft({
                          ...props.selection,
                          ids: event.currentTarget.checked
                            ? [...props.selection.ids, row().id]
                            : props.selection.ids.filter((id) => id !== row().id),
                        })
                      }
                    />
                    <span class="settings-row__title" title={row().name}>
                      {row().name}
                    </span>{" "}
                    <small
                      class="settings-row__desc"
                      dir={row().available ? "rtl" : undefined}
                      title={row().id}
                    >
                      <bdi>
                        {row().available
                          ? row().id
                          : t("configView.notifications.savedAgentUnavailable")}
                      </bdi>
                    </small>
                  </label>
                )}
              </For>
              <Show when={props.agentCatalog?.agentsLoading}>
                <p role="status">{t("common.loading")}</p>
              </Show>
              <Show
                when={
                  props.agentCatalog?.agentsError ||
                  (!props.agentCatalog?.agentsList?.agents && !props.agentCatalog?.agentsLoading)
                }
              >
                <p role="alert">
                  {t("configView.notifications.agentsLoadFailed")}{" "}
                  <button
                    type="button"
                    class="btn btn--sm"
                    disabled={props.agentCatalog?.agentsLoading}
                    onClick={() => props.onLoadAgents?.()}
                  >
                    {t("common.retry")}
                  </button>
                </p>
              </Show>
              <Show
                when={
                  props.agentCatalog?.agentsList?.agents &&
                  !props.agentCatalog.agentsLoading &&
                  !props.agentCatalog.agentsError &&
                  rows().length === 0
                }
              >
                <p role="status">
                  {t(
                    query().trim()
                      ? "configView.notifications.noMatchingAgents"
                      : "configView.notifications.noAgents",
                  )}
                </p>
              </Show>
            </div>
            <div class="muted" role="status">
              {props.selection.ids.length
                ? t("configView.notifications.agentsSelected", {
                    count: String(props.selection.ids.length),
                  })
                : t("configView.notifications.selectAgentRequired")}
            </div>
          </Show>
          <Show when={props.submission}>
            {(submission) => (
              <p class="muted" role="status">
                {t(
                  submission().state === "pending"
                    ? "common.saving"
                    : "configView.notifications.reviewAgentSelection",
                )}
              </p>
            )}
          </Show>
        </div>
        <openclaw-modal-actions class="oc-dialog__footer">
          <button class="btn" type="button" onClick={() => props.onClose()}>
            {t("common.cancel")}
          </button>
          <button class="btn primary" type="submit" disabled={blocked()}>
            {t("common.save")}
          </button>
        </openclaw-modal-actions>
      </form>
    </ModalDialog>
  );
}
