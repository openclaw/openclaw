import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveSessionRenamePatch, resolveSessionRenameValue } from "../../lib/session-rename.ts";
import type { SessionPatch } from "../../lib/sessions/patch.ts";
import type { SessionsPageMutationResult } from "./mutation-runner.ts";
import type { SessionsPageRequestScope } from "./request-scope.ts";

/** Type-only, so the dialog itself stays behind its lazy boundary. */
type InputDialogOpener = (typeof import("../../components/input-dialog.ts"))["showInputDialog"];

export function createSessionsDialog(onError: (error: unknown) => void) {
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
        onError(error);
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
  function rename(
    row: GatewaySessionRow,
    scope: SessionsPageRequestScope | null,
    isCurrent: (scope: SessionsPageRequestScope) => boolean,
    patch: (
      scope: SessionsPageRequestScope,
      value: SessionPatch,
    ) => Promise<SessionsPageMutationResult>,
  ) {
    if (!scope) {
      onError(t("sessionsView.actionRequiresConnection"));
      return undefined;
    }
    const initialValue = resolveSessionRenameValue(row);
    return open(() => ({
      signal: scope.signal,
      title: t("sessionsView.renameSessionPrompt"),
      defaultValue: initialValue,
      submit: async (value) => {
        if (!isCurrent(scope)) {
          return t("sessionsView.actionRequiresConnection");
        }
        const next = resolveSessionRenamePatch(value, initialValue, row.label);
        if (!next) {
          return null;
        }
        const result = await patch(scope, next);
        return typeof result === "object"
          ? formatUiError(result.error)
          : result === "completed"
            ? null
            : t("sessionsView.actionRequiresConnection");
      },
    }));
  }
  return { abort, open, rename };
}
