import { action, createMemo, createOptimistic, createSignal, Errored, For, Show } from "solid-js";
import { ModalDialog } from "../../components/modal-dialog.tsx";
import { Checkbox } from "../../components/solid/checkbox.tsx";
import { DialogHeader } from "../../components/solid/dialog-header.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { SettingsRow } from "../../components/solid/settings-ui.tsx";
import { normalizeAgentLabel } from "../../lib/agents/display.ts";
import type { AgentCapability } from "../../lib/agents/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import "./notification-agents.css";

export type NotificationAgentCatalog = Pick<
  AgentCapability["state"],
  "agentsList" | "agentsLoading" | "agentsError"
>;
export type NotificationAgentOptions = {
  agentCatalog?: NotificationAgentCatalog;
  onLoadAgents?: () => void;
  presentationScope?: Promise<void>;
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
  const names = (ids: readonly string[]) => {
    const agents = props.agentCatalog?.agentsList?.agents;
    return ids
      .map((id) => {
        const agent = agents?.find((entry) => entry.id === id);
        const name = agent ? normalizeAgentLabel(agent) : id;
        return (agents?.filter((entry) => normalizeAgentLabel(entry) === name).length ?? 0) > 1
          ? `${name} (${id})`
          : name;
      })
      .join(", ");
  };
  const summary = () =>
    props.agentIds === undefined
      ? t("configView.notifications.inheritAgents", {
          agents: props.inheritedAgentIds?.length
            ? names(props.inheritedAgentIds)
            : t("configView.notifications.allAgents"),
        })
      : props.agentIds.length
        ? names(props.agentIds)
        : t("configView.notifications.allAgents");
  return (
    <>
      <SettingsRow
        title={t("configView.notifications.agents")}
        control={
          <button
            type="button"
            class="btn notification-agents__trigger"
            disabled={props.disabled}
            aria-label={t("configView.notifications.chooseAgents")}
            title={summary()}
            onClick={() => {
              setDraft({
                mode:
                  props.agentIds === undefined
                    ? "inherit"
                    : props.agentIds.length
                      ? "specific"
                      : "all",
                ids: [...(props.agentIds ?? [])],
              });
              props.onLoadAgents?.();
            }}
          >
            <span>{summary()}</span>
            <Icon name="chevronDown" />
          </button>
        }
      />
      <Show when={draft()}>
        {(selection) => (
          <AgentSelectionDialog
            {...props}
            selection={selection()}
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
    onClose: () => void;
  },
) {
  const [query, setQuery] = createSignal("");
  const [saving, setSaving] = createOptimistic(false);
  const [attempt, setAttempt] = createSignal<{ result: Promise<void> }>();
  const outcome = createMemo(() => attempt()?.result.then(() => null), { loadingValue: undefined });
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
    saving() ||
    (props.selection.mode === "specific" && props.selection.ids.length === 0);
  const save = action(function* (result: Promise<void>) {
    setSaving(true);
    try {
      yield result;
      props.onClose();
    } catch {
      /* The outcome slot retains the error and draft. */
    }
  });
  const submit = () => {
    if (blocked()) {
      return;
    }
    const value =
      props.selection.mode === "inherit"
        ? undefined
        : props.selection.mode === "all"
          ? []
          : props.selection.ids;
    const result = Promise.resolve(props.onChange(value));
    setAttempt({ result });
    void save(result);
  };
  return (
    <ModalDialog
      open
      label={t("configView.notifications.chooseAgents")}
      class="notification-agents-modal"
      onOpenChange={(open) => {
        if (!open && !saving()) {
          props.onClose();
        }
      }}
      onModal-cancel={(event: Event) => {
        if (saving()) {
          event.preventDefault();
        }
      }}
    >
      <form
        class="oc-dialog notification-agents"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <DialogHeader
          title={t("configView.notifications.chooseAgents")}
          description={t(
            props.inherit
              ? "configView.notifications.installedApp"
              : "configView.notifications.accountDefaults",
          )}
          closeDisabled={saving()}
          onClose={() => props.onClose()}
        />
        <div class="oc-dialog__body">
          <SettingsSelect
            aria-label={t("configView.notifications.agentScope")}
            disabled={props.disabled || saving()}
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
            <div class="notification-agents__options">
              <For each={rows()} keyed={(row) => row.id}>
                {(row) => (
                  <label class="notification-agents__option">
                    <Checkbox
                      checked={props.selection.ids.includes(row().id)}
                      disabled={
                        props.disabled ||
                        saving() ||
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
                    <span>
                      <strong>{row().name}</strong>{" "}
                      <small>
                        {row().available
                          ? row().id
                          : t("configView.notifications.savedAgentUnavailable")}
                      </small>
                    </span>
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
          <Show when={!saving()}>
            <Errored
              fallback={(error) => (
                <p role="alert" class="cfg-field__error">
                  {formatUiError(error())}
                </p>
              )}
            >
              {outcome()}
            </Errored>
          </Show>
        </div>
        <openclaw-modal-actions class="oc-dialog__footer">
          <button class="btn" type="button" disabled={saving()} onClick={() => props.onClose()}>
            {t("common.cancel")}
          </button>
          <button class="btn primary" type="submit" disabled={blocked()}>
            {t(saving() ? "common.saving" : "common.save")}
          </button>
        </openclaw-modal-actions>
      </form>
    </ModalDialog>
  );
}
