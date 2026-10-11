// Importing the module keeps this file a module, so the block below augments it.
import "@solidjs/web";
import type { UpdateRunRecord } from "../../../src/infra/update-run-record.ts";
import type { SelectPicker } from "../components/select-picker.ts";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-tooltip": HTMLAttributes<HTMLElement> & { "prop:content": string };
      // Each caller validates PickerParams<Option>; the generic payload crosses
      // this DOM boundary intact, without erasing its option/callback pairing.
      "openclaw-select-picker": HTMLAttributes<SelectPicker> & { "prop:params": unknown };
      "openclaw-agent-memory-panel": HTMLAttributes<HTMLElement> & { "prop:agentId": string };
      "openclaw-update-run-view": HTMLAttributes<HTMLElement> & {
        "prop:run": UpdateRunRecord | null;
        "prop:connected": boolean;
      };
    }
  }
}
