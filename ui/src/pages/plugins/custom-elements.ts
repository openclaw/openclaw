import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import type { ConfigFormStructuredDraftProps } from "../../components/config-form-structured-draft.ts";
import type { OpenClawFilePreviewModal } from "../../components/file-preview-modal.ts";

// The remaining custom elements own their children and behavior during the page cutover.
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-config-form-structured-draft": HTMLAttributes<HTMLElement> & {
        "prop:props"?: ConfigFormStructuredDraftProps;
      };
      "wa-popup": HTMLAttributes<WaPopup> & {
        "prop:active"?: WaPopup["active"];
      };
      "openclaw-plugin-manager": HTMLAttributes<HTMLElement>;
      "openclaw-file-preview-modal": HTMLAttributes<OpenClawFilePreviewModal> & {
        layout?: OpenClawFilePreviewModal["layout"];
        "prop:label"?: OpenClawFilePreviewModal["label"];
        "prop:files"?: OpenClawFilePreviewModal["files"];
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
