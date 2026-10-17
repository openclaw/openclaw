import { formatUiError } from "../../lib/format-error.ts";

/** Type-only, so the dialog itself stays behind its lazy boundary. */
type InputDialogOpener = (typeof import("../../components/input-dialog.ts"))["showInputDialog"];

export function createSessionsDialog(onError: (message: string) => void) {
  // The page only aborts this owner during terminal disposal.
  const lifecycle = new AbortController();

  async function open(options: () => Parameters<InputDialogOpener>[0]): Promise<string | null> {
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
  }
  return { abort: () => lifecycle.abort(), open };
}
