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
export function modelPickerReadiness(container: HTMLElement, phase: "menu" | "options") {
  return `${phase}: ${JSON.stringify({
    open: container.matches("details[open]") || Boolean(container.querySelector("details[open]")),
    menu: Boolean(container.querySelector(".chat-controls__model-menu[aria-label]")),
    options: container.querySelectorAll("[data-chat-model-option]").length,
    fallback: container.querySelector('[role="alert"]')?.textContent?.slice(0, 200) ?? null,
    focus: container.ownerDocument.activeElement?.outerHTML.slice(0, 200) ?? null,
  })}`;
}
export const waitForModelMenu = (container: HTMLElement) =>
  waitForSolid(() =>
    expect(
      container.querySelector(".chat-controls__model-menu[aria-label]"),
      modelPickerReadiness(container, "menu"),
    ).not.toBeNull(),
  );

export function selectModelProvider(container: ParentNode, provider: string) {
  container
    .querySelector<HTMLButtonElement>(modelControlSelector("provider-toggle", provider))!
    .click();
  flush();
}
