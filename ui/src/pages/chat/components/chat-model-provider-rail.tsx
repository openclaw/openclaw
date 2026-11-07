import { createMemo, createSignal, For } from "solid-js";
import { providerDisplayLabel } from "../../../components/provider-icon-data.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createTabList } from "../../../lib/tabs.ts";
import { ChatModelProviderIcon, ChatModelTargetIcon } from "./chat-model-picker-options.tsx";
import { loadModelProviderOrder, saveModelProviderOrder } from "./model-provider-order.ts";

export function ChatModelProviderRail(props: {
  providers: string[];
  targets: readonly { id: string; label: string }[];
  active?: string;
  disabled: boolean;
  onSelect: (provider: string) => void;
}) {
  const [order, setOrder] = createSignal(loadModelProviderOrder());
  const providers = createMemo(() => [
    ...order().filter((id) => props.providers.includes(id)),
    ...props.providers.filter((id) => !order().includes(id)),
  ]);
  const items = createMemo(() => [
    ...providers().map((id) => ({ id, label: providerDisplayLabel(id), draggable: true })),
    ...props.targets.map((group) => ({
      id: `target:${group.id}`,
      label: group.label,
      draggable: false,
    })),
  ]);
  let root!: HTMLDivElement;
  let source: string | undefined;
  const [drag, setDrag] = createSignal<{ from: number; to: number }>();
  const [announcement, announce] = createSignal("");
  const move = (id: string, to: number) => {
    const next = [...providers()];
    const from = next.indexOf(id);
    if (from < 0 || to < 0 || to >= next.length || from === to) {
      return;
    }
    next.splice(from, 1);
    next.splice(to, 0, id);
    setOrder(next);
    saveModelProviderOrder(next);
    announce(`${providerDisplayLabel(id)}, ${to + 1} / ${next.length}`);
  };
  const tabs = createTabList(
    () => ({ active: props.active ?? null, onSelect: (id) => props.onSelect(id) }),
    () => items().map(({ id }) => ({ value: id, disabled: props.disabled })),
    () => root,
  );
  const shift = (id: string) => {
    const current = drag();
    const index = providers().indexOf(id);
    if (!current || index < 0 || index === current.from) {
      return 0;
    }
    return current.from < index && index <= current.to
      ? -38
      : current.to <= index && index < current.from
        ? 38
        : 0;
  };
  const endDrag = () => {
    source = undefined;
    setDrag(undefined);
  };
  return (
    <>
      <div
        ref={(element) => (root = element)}
        class="chat-controls__provider-rail"
        role="tablist"
        aria-label={t("chat.selectors.model")}
        aria-orientation="vertical"
      >
        <For each={items()} keyed={(item) => item.id}>
          {(item) => (
            <button
              ref={[tabs.ref(item().id)]}
              type="button"
              role="tab"
              class="chat-controls__provider-tab"
              data-tab-value={item().id}
              data-chat-model-provider-toggle={item().id}
              aria-label={item().label}
              aria-selected={props.active === item().id ? "true" : "false"}
              tabindex={tabs.tabIndex(item().id)}
              disabled={props.disabled}
              draggable={item().draggable && !props.disabled ? "true" : "false"}
              style={{ "--rail-shift": `${shift(item().id)}px` }}
              data-dragging={drag()?.from === providers().indexOf(item().id) ? "" : undefined}
              onDragStart={(event) => {
                source = item().id;
                const index = providers().indexOf(source);
                setDrag({ from: index, to: index });
                event.dataTransfer?.setData("text/plain", source);
              }}
              onDragOver={(event) => {
                if (source && item().draggable) {
                  event.preventDefault();
                  setDrag({
                    from: providers().indexOf(source),
                    to: providers().indexOf(item().id),
                  });
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (source && item().draggable) {
                  move(source, providers().indexOf(item().id));
                }
                endDrag();
              }}
              onDragEnd={endDrag}
              onClick={(event) => {
                event.stopPropagation();
                tabs.onClick(event);
              }}
              onKeyDown={(event) => {
                const offset = ["ArrowUp", "ArrowLeft"].includes(event.key)
                  ? -1
                  : ["ArrowDown", "ArrowRight"].includes(event.key)
                    ? 1
                    : 0;
                if (event.altKey && offset && item().draggable) {
                  event.preventDefault();
                  const id = item().id;
                  move(id, providers().indexOf(id) + offset);
                  queueMicrotask(() => tabs.element(id)?.focus({ preventScroll: true }));
                } else if (!event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
                  event.preventDefault();
                  const values = items();
                  const next =
                    values[
                      (values.findIndex(({ id }) => id === item().id) + offset + values.length) %
                        values.length
                    ];
                  if (next) {
                    props.onSelect(next.id);
                    tabs.element(next.id)?.focus({ preventScroll: true });
                  }
                } else {
                  tabs.onKeyDown(event);
                }
              }}
            >
              {item().draggable ? (
                <ChatModelProviderIcon provider={item().id} />
              ) : (
                <ChatModelTargetIcon />
              )}
            </button>
          )}
        </For>
      </div>
      <span class="sr-only" aria-live="polite">
        {announcement()}
      </span>
    </>
  );
}
