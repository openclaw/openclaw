import type { FilePreviewModalFile } from "../../components/file-preview-modal.ts";

type OpenClawFilePreviewModal = HTMLElementTagNameMap["openclaw-file-preview-modal"];

// The remaining custom elements own their children and behavior during the page cutover.
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-plugin-manager": HTMLAttributes<HTMLElement>;
      "openclaw-plugin-catalog-skeleton": HTMLAttributes<HTMLElement>;
      "openclaw-plugin-settings-editor": HTMLAttributes<HTMLElement>;
      "openclaw-plugin-credential-editor": HTMLAttributes<HTMLElement>;
      "openclaw-file-preview-modal": HTMLAttributes<OpenClawFilePreviewModal> & {
        layout?: OpenClawFilePreviewModal["layout"];
        "prop:label"?: OpenClawFilePreviewModal["label"];
        "prop:files"?: FilePreviewModalFile[];
        "prop:directories"?: OpenClawFilePreviewModal["directories"];
        "prop:activePath"?: OpenClawFilePreviewModal["activePath"];
        "prop:loading"?: OpenClawFilePreviewModal["loading"];
        "prop:fileLoading"?: OpenClawFilePreviewModal["fileLoading"];
        "prop:error"?: OpenClawFilePreviewModal["error"];
        "prop:notice"?: OpenClawFilePreviewModal["notice"];
        "onFile-preview-select"?: EventHandler<OpenClawFilePreviewModal, CustomEvent<string>>;
        "onFile-preview-retry"?: EventHandler<OpenClawFilePreviewModal, Event>;
        "onFile-preview-close"?: EventHandler<OpenClawFilePreviewModal, Event>;
      };
    }
  }
}
