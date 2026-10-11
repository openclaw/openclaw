import { solidTemplate } from "./chat-composer-interop.tsx";
import { ChatPermissionPicker, type ChatPermissionPickerProps } from "./chat-permission-picker.tsx";

export { ChatPermissionPicker, type ChatPermissionPickerProps } from "./chat-permission-picker.tsx";

export function renderChatPermissionPicker(params: ChatPermissionPickerProps) {
  return solidTemplate(ChatPermissionPicker, params);
}
