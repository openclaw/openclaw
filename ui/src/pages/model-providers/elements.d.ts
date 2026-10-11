import type { JSX } from "@solidjs/web";
import type { OpenClawModalDialog } from "../../components/modal-dialog.ts";
import type { ModelSetupPageProps } from "../model-setup/model-setup-page.tsx";
import type { ModelProvidersPageProps } from "./model-providers-page.tsx";

type PropertyAttributes<Props> = {
  [Key in keyof Props as `prop:${Key & string}`]?: Props[Key];
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-model-providers-page": JSX.HTMLAttributes<HTMLElement> &
        PropertyAttributes<ModelProvidersPageProps>;
      "openclaw-model-setup-page": JSX.HTMLAttributes<HTMLElement> &
        PropertyAttributes<ModelSetupPageProps>;
      "openclaw-modal-dialog": JSX.HTMLAttributes<OpenClawModalDialog> & {
        label?: string;
        "prop:label"?: string;
        "onModal-cancel"?: (event: Event) => void;
      };
    }
  }
}
