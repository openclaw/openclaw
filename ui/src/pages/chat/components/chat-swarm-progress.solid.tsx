import { createMemo, For, Show } from "solid-js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { isSessionRunActive } from "../../../lib/session-run-state.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";

type SwarmDotStatus = "queued" | "running" | "done" | "failed";

type SwarmDot = {
  label: string;
  status: SwarmDotStatus;
  duration: string;
};

const SWARM_STATUS_LABEL_KEYS: Record<SwarmDotStatus, string> = {
  queued: "common.queued",
  running: "common.running",
  done: "common.completed",
  failed: "labsPage.swarm.failedOrStopped",
};

function swarmDuration(row: GatewaySessionRow, status: SwarmDotStatus): string {
  if (status === "queued") {
    return "—";
  }
  let durationMs = row.runtimeMs;
  if (durationMs != null && status === "running" && row.runtimeSampledAt != null) {
    durationMs += Math.max(0, Date.now() - row.runtimeSampledAt);
  } else if (durationMs == null && row.startedAt != null) {
    const endAt = row.endedAt ?? (status === "running" ? Date.now() : undefined);
    if (endAt != null) {
      durationMs = Math.max(0, endAt - row.startedAt);
    }
  }
  return formatDurationCompact(durationMs) ?? "—";
}

function collectSwarmTasks(
  sessions: readonly GatewaySessionRow[],
  groups: NonNullable<GatewaySessionRow["swarm"]>["groups"],
): Map<string, SwarmDot[]> {
  const byGroup = new Map<string, Array<{ phaseRank: number; dot: SwarmDot }>>();
  const members = new Map(
    groups.map((group) => [
      group.groupId,
      new Map((group.children ?? []).map((child) => [child.sessionKey, child.status])),
    ]),
  );
  for (const row of sessions) {
    const groupId = row.swarmGroupId?.trim();
    const status = groupId ? members.get(groupId)?.get(row.key) : undefined;
    if (!status || !groupId) {
      continue;
    }
    const entries = byGroup.get(groupId) ?? [];
    entries.push({
      phaseRank: row.swarmPhaseRank ?? Number.MAX_SAFE_INTEGER,
      dot: {
        label: resolveSessionDisplayName(row.key, row),
        status,
        duration: swarmDuration(row, status),
      },
    });
    byGroup.set(groupId, entries);
  }
  return new Map(
    [...byGroup].map(([groupId, entries]) => [
      groupId,
      entries.toSorted((left, right) => left.phaseRank - right.phaseRank).map((entry) => entry.dot),
    ]),
  );
}

export type ChatSwarmProgressProps = {
  sessions: readonly GatewaySessionRow[];
  sessionKey: string;
  agentId?: string;
};

export function ChatSwarmProgress(props: ChatSwarmProgressProps) {
  const parent = createMemo(() =>
    props.sessions.find(
      (row) =>
        areUiSessionKeysEquivalent(row.key, props.sessionKey) &&
        ((props.sessionKey !== "global" && props.sessionKey !== "unknown") ||
          Boolean(props.agentId && row.agentId === props.agentId)),
    ),
  );
  const summary = () => parent()?.swarm;
  const details = createMemo(() => collectSwarmTasks(props.sessions, summary()?.groups ?? []));
  const outcome = () =>
    t(
      parent() && isSessionRunActive(parent()!)
        ? "labsPage.swarm.childOutcomeProcessing"
        : "labsPage.swarm.childOutcome",
    );
  return (
    <Show when={summary()?.groups.length}>
      <aside
        class="chat-swarm"
        data-test-id="chat-swarm"
        role="status"
        aria-live="off"
        aria-label={t("labsPage.swarm.title")}
      >
        <For each={summary()?.groups} keyed={(group) => group.groupId}>
          {(group) => {
            const tasks = () => details().get(group().groupId) ?? [];
            const total = () => group().queued + group().running + group().done + group().failed;
            const complete = () => group().done + group().failed;
            const terminal = () => complete() === total();
            const successful = () => terminal() && total() > 0 && group().failed === 0;
            const label = () =>
              total() === 1 && tasks()[0] ? tasks()[0]!.label : t("labsPage.swarm.groupTitle");
            const counts = () =>
              t(terminal() ? "labsPage.swarm.finished" : "labsPage.swarm.active", {
                running: String(group().running),
                queued: String(group().queued),
                done: String(group().done),
                failed: String(group().failed),
              });
            // Counts come from the requester registry, not the surviving child-session page.
            const markers = createMemo(() =>
              (["running", "queued", "failed", "done"] as const)
                .flatMap((status) =>
                  Array.from({ length: Math.min(group()[status], 64) }, () => status),
                )
                .slice(0, 64),
            );
            return (
              <details
                class={[
                  "chat-swarm__group",
                  {
                    "chat-swarm__group--failed": group().failed > 0,
                    "chat-swarm__group--completed": successful(),
                  },
                ]}
                data-swarm-group={group().groupId}
              >
                <summary class="chat-swarm__summary">
                  <Show
                    when={successful()}
                    fallback={
                      <>
                        <div class="chat-swarm__header">
                          <strong title={label()}>{label()}</strong>
                          <span>
                            {t("labsPage.swarm.progress", {
                              complete: String(complete()),
                              total: String(total()),
                            })}
                          </span>
                        </div>
                        <div class="chat-swarm__markers" role="img" aria-label={counts()}>
                          <For each={markers()}>
                            {(status) => (
                              <span
                                class={`chat-swarm__marker chat-swarm__marker--${status}`}
                                aria-hidden="true"
                              />
                            )}
                          </For>
                          <Show when={total() > markers().length}>
                            <span>+{total() - markers().length}</span>
                          </Show>
                        </div>
                        <div class="chat-swarm__counts">{counts()}</div>
                        <Show when={terminal()}>
                          <div class="chat-swarm__outcome">{outcome()}</div>
                        </Show>
                        <span class="chat-swarm__disclosure">
                          {t("labsPage.swarm.details")} <Icon name="chevronDown" />
                        </span>
                      </>
                    }
                  >
                    <span
                      class="chat-swarm__task-icon chat-swarm__task-icon--done"
                      aria-hidden="true"
                    >
                      <Icon name="check" />
                    </span>
                    <div class="chat-swarm__header">
                      <strong title={label()}>{label()}</strong>
                    </div>
                    <span class="chat-swarm__counts">
                      {t("labsPage.swarm.completed", { done: String(group().done) })}
                    </span>
                    <span class="chat-swarm__disclosure">
                      <span class="sr-only">{t("labsPage.swarm.details")}</span>
                      <Icon name="chevronDown" />
                    </span>
                  </Show>
                </summary>
                <Show when={successful()}>
                  <div class="chat-swarm__outcome">{outcome()}</div>
                </Show>
                <div class="chat-swarm__tasks" role="list">
                  <Show when={tasks().length === 0}>
                    <div class="chat-swarm__outcome">{t("labsPage.swarm.detailsUnavailable")}</div>
                  </Show>
                  <For each={tasks()}>
                    {(task) => (
                      <div class="chat-swarm__task" role="listitem">
                        <span
                          class={`chat-swarm__task-icon chat-swarm__task-icon--${task.status}`}
                          role="img"
                          aria-label={t(SWARM_STATUS_LABEL_KEYS[task.status])}
                        >
                          <Icon
                            name={
                              task.status === "done"
                                ? "check"
                                : task.status === "failed"
                                  ? "alertTriangle"
                                  : task.status === "running"
                                    ? "loader"
                                    : "clock"
                            }
                          />
                        </span>
                        <span class="chat-swarm__task-name">{task.label}</span>
                        <span class="chat-swarm__task-duration">{task.duration}</span>
                      </div>
                    )}
                  </For>
                </div>
              </details>
            );
          }}
        </For>
        <Show when={(summary()?.otherActiveGroups ?? 0) > 0}>
          <div class="chat-swarm__outcome">
            {t("labsPage.swarm.otherGroups", { count: String(summary()?.otherActiveGroups) })}
          </div>
        </Show>
      </aside>
    </Show>
  );
}
