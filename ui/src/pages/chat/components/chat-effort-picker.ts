import { solidTemplate } from "./chat-composer-interop.tsx";
import { ChatEffortPicker, type ChatEffortPickerParams } from "./chat-effort-picker.tsx";

export { ChatEffortPicker, type ChatEffortPickerParams } from "./chat-effort-picker.tsx";

export function renderChatEffortPicker(params: ChatEffortPickerParams) {
  return solidTemplate(ChatEffortPicker, params);
}
