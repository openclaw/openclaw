import { createSignal } from "solid-js";
import type { ChatModelPickerOptionProps } from "./chat-model-picker-options.ts";

export function createChatModelFavoriteReorder(options: {
  scope: () => object | undefined;
  rows: () => readonly { value: string }[] | undefined;
  disabled: () => boolean;
  move: (source: string, destination: string) => void;
}) {
  let dragSource: { model: string; scope: object | undefined } | undefined;
  const [drop, setDrop] = createSignal<{ model: string; side: "before" | "after" }>();
  const end = () => {
    dragSource = undefined;
    setDrop(undefined);
  };
  const indexOf = (model: string) => options.rows()?.findIndex((row) => row.value === model) ?? -1;
  return (model: () => string): NonNullable<ChatModelPickerOptionProps["reorder"]> => {
    const sourceFor = () =>
      !options.disabled() && dragSource?.scope === options.scope() && dragSource?.model !== model()
        ? dragSource?.model
        : undefined;
    return {
      get disabled() {
        return options.disabled();
      },
      get indicator() {
        const target = drop();
        return target?.model === model() ? target.side : undefined;
      },
      onDragStart(event) {
        if (options.disabled() || !event.dataTransfer) {
          event.preventDefault();
          return;
        }
        dragSource = { model: model(), scope: options.scope() };
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-openclaw-model-favorite", "move");
      },
      onDragEnd: end,
      onDragOver(event) {
        const source = sourceFor();
        if (!source || !event.dataTransfer) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const target = model();
        const side = indexOf(source) < indexOf(target) ? "after" : "before";
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
        const source = sourceFor();
        if (!source) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        end();
        options.move(source, model());
      },
      onMove(offset) {
        const index = indexOf(model());
        const destination = index < 0 ? undefined : options.rows()?.[index + offset];
        if (destination && !options.disabled()) {
          options.move(model(), destination.value);
        }
      },
    };
  };
}
