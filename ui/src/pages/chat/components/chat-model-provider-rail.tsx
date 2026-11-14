import { createMemo, createSignal, For } from "solid-js";
import {
  providerDisplayLabel,
  type ProviderPresentation,
} from "../../../components/provider-icon-data.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { Tooltip } from "../../../components/solid/tooltip.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { createMediaQuery } from "../../../lib/reactive/platform.ts";
import { createTabList } from "../../../lib/tabs.ts";
import { ChatModelProviderIcon, ChatModelTargetIcon } from "./chat-model-picker-options.tsx";
import { loadModelProviderOrder, saveModelProviderOrder } from "./model-provider-order.ts";

export function ChatModelProviderRail(props: {
  providers: string[];
  favorites?: boolean;
  presentation: (provider: string) => ProviderPresentation | undefined;
  targets: readonly { id: string; label: string }[];
  active?: string;
  disabled: boolean;
  onSelect: (provider: string) => void;
}) {
  const horizontal = createMediaQuery("(max-width: 640px)");
  const [order, setOrder] = createSignal(loadModelProviderOrder());
  const providers = createMemo(() => [
    ...order().filter((id) => props.providers.includes(id)),
    ...props.providers.filter((id) => !order().includes(id)),
  ]);
  const items = createMemo(() => [
    ...(props.favorites
      ? [{ id: "$favorites", label: t("chat.modelFavorites.label"), draggable: false }]
      : []),
    ...providers().map((id) => ({
      id,
      label: providerDisplayLabel(id, props.presentation(id)),
      draggable: true,
    })),
    ...props.targets.map((group) => ({
      id: `target:${group.id}`,
      label: group.label,
      draggable: false,
    })),
  ]);
  let root!: HTMLDivElement;
  let source: string | undefined;
  let dragOrigin = { x: 0, y: 0 };
  const [dragOffset, setDragOffset] = createSignal({ x: 0, y: 0 });
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
    announce(`${providerDisplayLabel(id, props.presentation(id))}, ${to + 1} / ${next.length}`);
  };
  const tabs = createTabList(
    () => ({ active: props.active ?? null, onSelect: (id) => props.onSelect(id) }),
    () => items().map(({ id }) => ({ value: id, disabled: props.disabled })),
    () => root,
    { revealActive: true },
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
    setDragOffset({ x: 0, y: 0 });
  };
  return (
    <>
      <div
        ref={(element) => (root = element)}
        class="chat-controls__provider-rail"
        data-dragging={drag() ? "" : undefined}
        style={{
          "--rail-drag-x": `${dragOffset().x}px`,
          "--rail-drag-y": `${dragOffset().y}px`,
        }}
        role="tablist"
        aria-label={t("chat.selectors.model")}
        aria-orientation={horizontal() ? "horizontal" : "vertical"}
        onDragOver={(event) => {
          if (source) {
            setDragOffset({
              x: event.clientX - dragOrigin.x,
              y: event.clientY - dragOrigin.y,
            });
          }
        }}
      >
        <For each={items()} keyed={(item) => item.id}>
          {(item) => (
            <Tooltip
              content={item().label}
              disabled={props.active === item().id}
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
            >
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
                  if (!item().draggable) {
                    event.preventDefault();
                    return;
                  }
                  source = item().id;
                  dragOrigin = { x: event.clientX, y: event.clientY };
                  const index = providers().indexOf(source);
                  setDrag({ from: index, to: index });
                  event.dataTransfer?.setData("text/plain", source);
                  // Paint the moving tab in the rail instead of the browser's drag image.
                  event.dataTransfer?.setDragImage(document.createElement("canvas"), 0, 0);
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
                {item().id === "$favorites" ? (
                  <Icon name="star" class="chat-controls__provider-icon" />
                ) : item().draggable ? (
                  <ChatModelProviderIcon
                    provider={item().id}
                    presentation={props.presentation(item().id)}
                  />
                ) : (
                  <ChatModelTargetIcon />
                )}
              </button>
            </Tooltip>
          )}
        </For>
      </div>
      <span class="sr-only" aria-live="polite">
        {announcement()}
      </span>
    </>
  );
}
