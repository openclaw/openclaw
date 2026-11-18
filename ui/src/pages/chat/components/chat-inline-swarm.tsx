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
const glyphs: Record<Status, string> = { queued: "", running: "•", done: "✓", failed: "×" };

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
      <div class="chat-inline-swarm__header" role="status" aria-atomic="true">
        <strong>{t("chat.inlineSwarm.title")}</strong>
        <span>
          {t("chat.inlineSwarm.progress", {
            done: String(group().done + group().failed),
            total: String(total()),
          })}
        </span>
      </div>
      <div class="chat-inline-swarm__markers">
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
                    class="chat-inline-swarm__marker"
                    data-state={child().status}
                    role="img"
                    aria-label={label()}
                    title={label()}
                  >
                    {glyphs[child().status]}
                  </span>
                }
              >
                {(open) => (
                  <button
                    type="button"
                    class="chat-inline-swarm__marker"
                    data-state={child().status}
                    aria-label={label()}
                    title={label()}
                    onClick={() => open()(child().sessionKey)}
                  >
                    {glyphs[child().status]}
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
      <div class="chat-inline-swarm__counts">
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
