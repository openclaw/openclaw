import { createMemo, Show } from "solid-js";
import { COMMAND_PALETTE_DIALOG_STYLE } from "../components/command-palette-contract.ts";
import { CommandPaletteInput } from "../components/command-palette-input.tsx";
import { t } from "../lib/reactive/i18n.ts";
import type { CommandPaletteLoadingState } from "./app-shell-command-palette-loading.ts";

export function CommandPaletteLoading(props: {
  state: CommandPaletteLoadingState;
  revision: number;
  onClose: () => void;
}) {
  const current = createMemo(() => {
    void props.revision;
    return {
      defined: Boolean(customElements.get("openclaw-modal-dialog")),
      value: props.state.value,
      readOnly: props.state.submitRequested,
    };
  });
  // An unrelated shell refresh must not rewrite the live field's selection.
  const value = createMemo(() => current().value);
  return (
    <Show when={current().defined}>
      <openclaw-modal-dialog
        class="cmd-palette-overlay palette"
        label={t("palette.placeholder")}
        style={COMMAND_PALETTE_DIALOG_STYLE}
        onModal-cancel={() => props.onClose()}
      >
        <div
          class="cmd-palette"
          aria-busy="true"
          onCompositionStart={() => props.state.handleCompositionStart()}
          onCompositionEnd={() => props.state.handleCompositionEnd()}
          onKeyDown={(event) => props.state.handleKeydown(event)}
        >
          <CommandPaletteInput
            value={value()}
            placeholder={t("palette.placeholder")}
            onInputRef={(element, previous) => props.state.inputRef(element, previous)}
            onValueChange={(nextValue, event) => props.state.captureInput(nextValue, event)}
            onPaste={(event) => props.state.handlePaste(event)}
            readOnly={current().readOnly}
          />
          <div class="cmd-palette__empty" role="status">
            {t("common.loading")}
          </div>
        </div>
      </openclaw-modal-dialog>
    </Show>
  );
}
