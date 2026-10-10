import type { JSX } from "@solidjs/web";
import type { AgentEmojiPicker } from "../../components/agent-emoji-picker.ts";
import type { OpenClawModalDialog } from "../../components/modal-dialog.ts";
import type { MultiSelect } from "../../components/multi-select.ts";

type PropertyBindings<T> = { [Key in keyof T as `prop:${Key & string}`]?: T[Key] };

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-agent-emoji-picker": JSX.HTMLAttributes<AgentEmojiPicker> &
        PropertyBindings<AgentEmojiPicker>;
      "openclaw-multi-select": JSX.HTMLAttributes<MultiSelect> & PropertyBindings<MultiSelect>;
      "openclaw-modal-dialog": JSX.HTMLAttributes<OpenClawModalDialog> &
        PropertyBindings<OpenClawModalDialog> & {
          manual?: boolean;
          label?: string;
          description?: string;
          "onModal-cancel"?: JSX.EventHandler<OpenClawModalDialog, Event>;
        };
    }
  }
}
