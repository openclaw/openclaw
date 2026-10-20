/**
 * Opt-out for confirms whose action is repeatable and recoverable. Callers own
 * the storage; passing this is what makes the checkbox exist at all, so serious
 * confirms stay unskippable by simply not offering one.
 */
export type ConfirmDialogSkipPreference = {
  /** True when the operator already chose to stop being asked. */
  skipped: boolean;
  /** Persists that choice; runs only when they confirm with the box ticked. */
  remember: () => void;
};

export type ConfirmDialogOptions = {
  title?: string;
  message: string;
  details?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  signal?: AbortSignal;
  skipPreference?: ConfirmDialogSkipPreference;
  requiredAcknowledgement?: string;
  canConfirm?: () => boolean;
};

export type ConfirmDialogChoiceOptions = ConfirmDialogOptions & { alternativeLabel: string };
export type ConfirmDialogChoice = "confirm" | "alternative" | null;
