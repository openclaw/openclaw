import type { ArtifactSummary } from "../../../../packages/gateway-protocol/src/schema/artifacts.js";
import { Icon } from "../../components/solid/icon.tsx";
import { AttachmentFileIcon } from "./components/chat-attachment-file-icon-solid.tsx";

export const detailsOutputsIcons = {
  renderArtifactIcon: (artifact: ArtifactSummary) => (
    <AttachmentFileIcon filename="" mimeType={artifact.mimeType} mode="preview-with-favicon" />
  ),
  renderViewAllIcon: () => <Icon name="folders" />,
};
