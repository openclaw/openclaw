import { Icon } from "../../components/solid/icon.tsx";
import { AttachmentFileIcon } from "./components/chat-attachment-file-icon-solid.tsx";
import type { ChatDetailsOutputsIcons } from "./components/chat-details-types.ts";

export const detailsOutputsIcons: ChatDetailsOutputsIcons = {
  renderArtifactIcon: (artifact) => (
    <AttachmentFileIcon filename="" mimeType={artifact.mimeType} mode="preview-with-favicon" />
  ),
  renderViewAllIcon: () => <Icon name="folders" />,
};
