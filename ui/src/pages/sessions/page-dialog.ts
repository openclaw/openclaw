import { formatUiError } from "../../lib/format-error.ts";

/** Type-only, so the dialog itself stays behind its lazy boundary. */
type InputDialogOpener = (typeof import("../../components/input-dialog.ts"))["showInputDialog"];

export class SessionsPageDialog {
  /** Only one dialog is open at a time; disconnect closes whichever it is. */
  private lifecycle: AbortController | null = null;

  constructor(private readonly onError: (message: string) => void) {}

  abort() {
    this.lifecycle?.abort();
  }

  async open(options: () => Parameters<InputDialogOpener>[0]): Promise<string | null> {
    // Reentrant opens share the live controller but must not retire it on completion.
    const active = this.lifecycle;
    const lifecycle = active ?? new AbortController();
    this.lifecycle = lifecycle;
    try {
      const showInputDialog = await this.load();
      if (!showInputDialog) {
        return null;
      }
      const resolved = options();
      return (
        (await showInputDialog({
          ...resolved,
          signal: resolved.signal
            ? AbortSignal.any([lifecycle.signal, resolved.signal])
            : lifecycle.signal,
        })) ?? null
      );
    } finally {
      if (!active && this.lifecycle === lifecycle) {
        this.lifecycle = null;
      }
    }
  }

  /** A dialog that never opens still owes the operator a visible outcome. */
  private async load(): Promise<InputDialogOpener | null> {
    try {
      return (await import("../../components/input-dialog.ts")).showInputDialog;
    } catch (error) {
      this.onError(formatUiError(error));
      return null;
    }
  }
}
