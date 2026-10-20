import { createSignal } from "solid-js";
import { expect, vi } from "vitest";
import { mountSolid, type MountSolidOptions } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatModelPicker, type ChatModelPickerParams } from "./chat-model-picker.tsx";

type PickerProps = ChatModelPickerParams;
export function modelControlSelector(name: string, value?: string) {
  return `[data-chat-model-${name}${value === undefined ? "" : `="${value}"`}]`;
}
type Option = PickerProps["modelOptions"][number];
export function modelOption(provider: string, id: string, overrides: Partial<Option> = {}): Option {
  return {
    provider,
    value: `${provider}/${id}`,
    commitValue: `${provider}/${id}`,
    label: id,
    isDefault: false,
    ...overrides,
  };
}
export function modelPickerProps(overrides: Partial<PickerProps> = {}): PickerProps {
  return {
    disabled: false,
    modelSelectionLocked: false,
    modelOptions: [],
    selectedModelValue: "fixture/current",
    sessionModelPinned: true,
    sessionKey: "main",
    triggerModelLabel: "Current",
    onModelSelect: vi.fn(async () => {}),
    ...overrides,
  };
}
export function mountModelPicker(params: Partial<PickerProps>, options?: MountSolidOptions) {
  let update!: (next: PickerProps) => void;
  const view = mountSolid(() => {
    const [props, setProps] = createSignal(modelPickerProps(params));
    update = (next) => {
      setProps(() => next);
      flush();
    };
    return <ChatModelPicker {...props()} />;
  }, options);
  flush();
  return { ...view, update };
}
export const waitForModelMenu = (container: HTMLElement) =>
  waitForSolid(() => expect(container.querySelector(".chat-controls__model-menu")).not.toBeNull());
