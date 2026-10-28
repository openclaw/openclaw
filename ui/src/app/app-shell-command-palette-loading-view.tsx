import { createMemo, lazy } from "solid-js";
import { COMMAND_PALETTE_DIALOG_STYLE } from "../components/command-palette-contract.ts";
import { CommandPaletteInput, CommandPaletteModes } from "../components/command-palette-input.tsx";
import { t } from "../lib/reactive/i18n.ts";
import type { CommandPaletteLoadingState } from "./app-shell-command-palette-loading.ts";
import { ShellComponentBoundary } from "./app-shell-component-boundary.tsx";

const ModalDialog = lazy(() => import("../components/modal-dialog.tsx"), { export: "ModalDialog" });

export function CommandPaletteLoading(props: {
  state: CommandPaletteLoadingState;
  onClose: () => void;
  retryStale?: (canReload: () => boolean) => Promise<boolean>;
}) {
  let initialInput!: HTMLTextAreaElement;
  // An unrelated shell refresh must not rewrite the live field's selection.
  const value = createMemo(() => props.state.value());
  return (
    <ShellComponentBoundary
      label={t("palette.placeholder")}
      onClose={props.onClose}
      retryStale={props.retryStale}
    >
      <ModalDialog
        initialFocus={() => initialInput}
        class="cmd-palette-overlay palette"
        label={t("palette.placeholder")}
        style={COMMAND_PALETTE_DIALOG_STYLE}
        onModal-cancel={() => props.onClose()}
      >
        <CommandPaletteModes
          mode={props.state.mode()}
          onChange={(mode) => props.state.setMode(mode)}
          disabled={props.state.submitRequested()}
        />
        <div
          id="cmd-palette-panel"
          role="tabpanel"
          aria-labelledby={`cmd-palette-tab-${props.state.mode()}`}
          class="cmd-palette"
          aria-busy="true"
          onCompositionStart={() => props.state.handleCompositionStart()}
          onCompositionEnd={() => props.state.handleCompositionEnd()}
          onKeyDown={(event) => props.state.handleKeydown(event)}
          onDragOver={(event) => props.state.handleDragOver(event)}
          onDrop={(event) => props.state.handleDrop(event)}
        >
          <CommandPaletteInput
            onAutofocusRef={(element) => {
              initialInput = element;
            }}
            value={value()}
            placeholder={t(
              props.state.mode() === "compose"
                ? props.state.hasAttachments()
                  ? "palette.attachmentPrompt"
                  : "palette.composePlaceholder"
                : "palette.placeholder",
            )}
            onInputRef={(element, previous) => props.state.inputRef(element, previous)}
            onValueChange={(nextValue, event) => props.state.captureInput(nextValue, event)}
            onPaste={(event) => props.state.handlePaste(event)}
            readOnly={props.state.submitRequested()}
          />
          <div class="cmd-palette__empty" role="status">
            {t("common.loading")}
          </div>
        </div>
      </ModalDialog>
    </ShellComponentBoundary>
  );
}
