import { formatUiError } from "../../lib/format-error.ts";

/** Type-only, so the dialog itself stays behind its lazy boundary. */
type InputDialogOpener = (typeof import("../../components/input-dialog.ts"))["showInputDialog"];

export function createSessionsDialog(onError: (message: string) => void) {
  /** Only one dialog is open at a time; disconnect closes whichever it is. */
  let currentLifetime: AbortController | null = null;

  function abort() {
    currentLifetime?.abort();
  }

  async function open(options: () => Parameters<InputDialogOpener>[0]): Promise<string | null> {
    // Reentrant opens share the live controller but must not retire it on completion.
    const active = currentLifetime;
    const lifecycle = active ?? new AbortController();
    currentLifetime = lifecycle;
    try {
      let showInputDialog: InputDialogOpener;
      try {
        ({ showInputDialog } = await import("../../components/input-dialog.ts"));
      } catch (error) {
        onError(formatUiError(error));
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
      if (!active && currentLifetime === lifecycle) {
        currentLifetime = null;
      }
    }
  }
  return { abort, open };
}
