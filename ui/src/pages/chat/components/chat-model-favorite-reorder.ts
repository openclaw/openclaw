import { createSignal } from "solid-js";
import type { ChatModelPickerOptionProps } from "./chat-model-picker-options.ts";

export function createChatModelFavoriteReorder(options: {
  scope: () => object | undefined;
  rows: () => readonly { value: string }[] | undefined;
  disabled: () => boolean;
  move: (source: string, destination: string, side: "before" | "after") => void;
}) {
  const [dragSource, setDragSource] = createSignal<{ model: string; scope: object }>();
  const [drop, setDrop] = createSignal<{ model: string; side: "before" | "after" }>();
  const end = () => {
    setDragSource(undefined);
    setDrop(undefined);
  };
  const indexOf = (model: string) => options.rows()?.findIndex((row) => row.value === model) ?? -1;
  return (model: () => string): NonNullable<ChatModelPickerOptionProps["reorder"]> => {
    function dropSlot(
      event: DragEvent & { currentTarget: HTMLElement },
    ): { source: string; side: "before" | "after" } | undefined {
      const source = dragSource();
      if (!source || source.scope !== options.scope() || options.disabled()) {
        return undefined;
      }
      const from = indexOf(source.model);
      const to = indexOf(model());
      const { top, height } = event.currentTarget.getBoundingClientRect();
      const side = event.clientY < top + height / 2 ? "before" : "after";
      if (from < 0 || to < 0 || from === to || from === to - (side === "before" ? 1 : -1)) {
        return undefined;
      }
      return { source: source.model, side };
    }
    return {
      get disabled() {
        return options.disabled();
      },
      get dragging() {
        const source = dragSource();
        return source?.model === model() && source.scope === options.scope();
      },
      get indicator() {
        const target = drop();
        return target?.model === model() ? target.side : undefined;
      },
      onDragStart(event) {
        const scope = options.scope();
        if (!scope || options.disabled() || !event.dataTransfer) {
          event.preventDefault();
          return;
        }
        setDragSource({ model: model(), scope });
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-openclaw-model-favorite", "move");
      },
      onDragEnd: end,
      onDragOver(event) {
        const slot = dropSlot(event);
        if (!slot || !event.dataTransfer) {
          setDrop(undefined);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const target = model();
        const { side } = slot;
        setDrop((previous) =>
          previous?.model === target && previous.side === side ? previous : { model: target, side },
        );
      },
      onDragLeave(event) {
        if (
          event.currentTarget instanceof Element &&
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        setDrop((target) => (target?.model === model() ? undefined : target));
      },
      onDrop(event) {
        const slot = dropSlot(event);
        if (!slot) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        end();
        options.move(slot.source, model(), slot.side);
      },
      onMove(offset) {
        const index = indexOf(model());
        const destination = index < 0 ? undefined : options.rows()?.[index + offset];
        if (destination && !options.disabled()) {
          options.move(model(), destination.value, offset < 0 ? "before" : "after");
        }
      },
    };
  };
}
