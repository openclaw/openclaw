import { solidTemplate } from "./chat-composer-controls.ts";
import { ChatPermissionPicker, type ChatPermissionPickerProps } from "./chat-permission-picker.tsx";

export { ChatPermissionPicker, type ChatPermissionPickerProps } from "./chat-permission-picker.tsx";

export function renderChatPermissionPicker(params: ChatPermissionPickerProps) {
  return solidTemplate(ChatPermissionPicker, params);
}
