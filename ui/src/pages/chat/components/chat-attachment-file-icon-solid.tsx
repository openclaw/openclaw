import { createMemo } from "solid-js";
import { inferControlUiPublicAssetPath } from "../../../app/public-assets.ts";
import {
  resolveAttachmentFileIcon,
  type AttachmentFileVisualMode,
} from "./chat-attachment-file-icon.ts";

export function AttachmentFileIcon(props: {
  filename: string;
  mimeType?: string;
  mode: AttachmentFileVisualMode;
  unavailable?: boolean;
  loading?: boolean;
}) {
  const resolved = createMemo(() => resolveAttachmentFileIcon(props.filename, props.mimeType));
  const large = () => props.mode === "large-placeholder";
  const asset = (path: string) => inferControlUiPublicAssetPath(`file-icons/${path}.svg`);
  const themedAsset = (theme: "light" | "dark") =>
    asset(
      large()
        ? `large/shell-${theme}`
        : resolved().compact
          ? `compact/${theme}/${resolved().compact}`
          : `compact/unknown-${theme}`,
    );
  return (
    <span
      class={[
        "chat-attachment-file-icon",
        {
          "chat-attachment-file-icon--unavailable": props.unavailable,
          skeleton: props.loading,
        },
      ]}
      data-family={resolved().family}
      data-mode={props.mode}
      aria-hidden="true"
      style={{
        width: large() ? "44px" : "20px",
        height: large() ? "44px" : "20px",
        "--chat-file-icon-light": `url("${themedAsset("light")}")`,
        "--chat-file-icon-dark": `url("${themedAsset("dark")}")`,
        "--chat-file-icon-overlay": `url("${asset(`overlays/${resolved().family}`)}")`,
        "--chat-file-icon-accent": resolved().accent,
      }}
    >
      {large() ? <span class="chat-attachment-file-icon__overlay" /> : null}
    </span>
  );
}
