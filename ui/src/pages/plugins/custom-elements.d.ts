import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import type WaTabPanel from "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
import type { JSX } from "@solidjs/web";
import type { OpenClawFilePreviewModal } from "../../components/file-preview-modal.ts";

// The remaining custom elements own their children and behavior during the page cutover.
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "wa-dropdown": JSX.HTMLAttributes<WaDropdown> & {
        placement?: WaDropdown["placement"];
        "onWa-select"?: JSX.EventHandler<WaDropdown, CustomEvent<{ item: WaDropdownItem }>>;
      };
      "wa-dropdown-item": JSX.HTMLAttributes<WaDropdownItem> & {
        value?: string;
        disabled?: boolean;
      };
      "wa-popup": JSX.HTMLAttributes<WaPopup> & {
        "prop:active"?: WaPopup["active"];
      };
      "wa-tab-panel": JSX.HTMLAttributes<WaTabPanel> & {
        name: string;
        active?: boolean;
      };
      "openclaw-plugin-manager": JSX.HTMLAttributes<HTMLElement>;
      "openclaw-file-preview-modal": JSX.HTMLAttributes<OpenClawFilePreviewModal> & {
        layout?: OpenClawFilePreviewModal["layout"];
        "prop:label"?: OpenClawFilePreviewModal["label"];
        "prop:files"?: OpenClawFilePreviewModal["files"];
        "prop:directories"?: OpenClawFilePreviewModal["directories"];
        "prop:activePath"?: OpenClawFilePreviewModal["activePath"];
        "prop:loading"?: OpenClawFilePreviewModal["loading"];
        "prop:fileLoading"?: OpenClawFilePreviewModal["fileLoading"];
        "prop:error"?: OpenClawFilePreviewModal["error"];
        "prop:notice"?: OpenClawFilePreviewModal["notice"];
        "onFile-preview-select"?: JSX.EventHandler<OpenClawFilePreviewModal, CustomEvent<string>>;
        "onFile-preview-retry"?: JSX.EventHandler<OpenClawFilePreviewModal, Event>;
        "onFile-preview-close"?: JSX.EventHandler<OpenClawFilePreviewModal, Event>;
      };
    }
  }
}
