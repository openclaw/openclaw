import { html } from "lit";
import { solidContent } from "../lit/solid-content.tsx";
import { AppearancePicker, type AppearancePickerProps } from "./session-icon-picker-solid.tsx";

export { sessionEmojiPickerShortcut } from "./session-icon-choices.ts";

export function renderAppearancePicker(props: AppearancePickerProps) {
  return html`${solidContent(AppearancePicker, props)}`;
}
