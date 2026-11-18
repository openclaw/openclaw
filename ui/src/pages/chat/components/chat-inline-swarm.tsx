import { For, Show } from "solid-js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { t } from "../../../lib/reactive/i18n.ts";

type SwarmGroup = NonNullable<GatewaySessionRow["swarm"]>["groups"][number];
type Status = "queued" | "running" | "done" | "failed";

export type InlineSwarm = {
  group: SwarmGroup;
  labels: ReadonlyMap<string, string>;
  onOpenChild?: (key: string) => void;
};

const statuses = ["queued", "running", "done", "failed"] as const;
const markerColor: Record<Status, string> = {
  queued: "var(--border-strong)",
  running: "var(--info)",
  done: "var(--ok)",
  failed: "var(--danger)",
};

function SwarmMarker(props: { status: Status }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="1"
        y="1"
        width="14"
        height="14"
        rx="2"
        stroke={markerColor[props.status]}
        stroke-width="1"
      />
      <Show when={props.status === "running"}>
        <circle cx="8" cy="8" r="1.5" fill={markerColor.running} stroke="none" />
      </Show>
      <Show when={props.status === "done"}>
        <path d="m4 8 2.5 2.5L12 5" stroke={markerColor.done} stroke-width="1.5" />
      </Show>
      <Show when={props.status === "failed"}>
        <path d="m5 5 6 6m0-6-6 6" stroke={markerColor.failed} stroke-width="1.5" />
      </Show>
    </svg>
  );
}

export function ChatInlineSwarm(props: { swarm: InlineSwarm }) {
  const group = () => props.swarm.group;
  const total = () => group().queued + group().running + group().done + group().failed;
  const children = () => group().children ?? [];
  const hidden = () => total() - children().length;
  return (
    <section
      class="chat-inline-swarm"
      data-test-id="chat-inline-swarm"
      aria-label={t("chat.inlineSwarm.title")}
    >
      <div class="label chip-row" role="status" aria-atomic="true">
        <strong>{t("chat.inlineSwarm.title")}</strong>
        <span>
          {t("chat.inlineSwarm.progress", {
            done: String(group().done + group().failed),
            total: String(total()),
          })}
        </span>
      </div>
      <div class="chip-row">
        <For each={children()} keyed={(child) => child.sessionKey}>
          {(child) => {
            const name = () => props.swarm.labels.get(child().sessionKey);
            const label = () => {
              const worker = name();
              const status = t(`chat.inlineSwarm.status.${child().status}`);
              return worker ? t("chat.inlineSwarm.childStatus", { name: worker, status }) : status;
            };
            return (
              <Show
                when={name() ? props.swarm.onOpenChild : undefined}
                fallback={
                  <span
                    class="oc-icon-button oc-icon-button--28"
                    data-state={child().status}
                    role="img"
                    aria-label={label()}
                    title={label()}
                  >
                    <SwarmMarker status={child().status} />
                  </span>
                }
              >
                {(open) => (
                  <button
                    type="button"
                    class="oc-icon-button oc-icon-button--28"
                    data-state={child().status}
                    aria-label={label()}
                    title={label()}
                    onClick={() => open()(child().sessionKey)}
                  >
                    <SwarmMarker status={child().status} />
                  </button>
                )}
              </Show>
            );
          }}
        </For>
        <Show when={hidden() > 0 && children().length > 0}>
          <span title={t("chat.inlineSwarm.moreWorkers", { count: String(hidden()) })}>
            {t("chat.inlineSwarm.overflow", { count: String(hidden()) })}
          </span>
        </Show>
      </div>
      <div class="label chip-row">
        <For each={statuses}>
          {(status) => (
            <Show when={group()[status] > 0}>
              <span>
                {t(`chat.inlineSwarm.count.${status}`, { count: String(group()[status]) })}
              </span>
            </Show>
          )}
        </For>
      </div>
    </section>
  );
}
