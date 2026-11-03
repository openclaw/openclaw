import { createEffect } from "solid-js";

type NativeDraftControl = HTMLInputElement | HTMLTextAreaElement;
type NativeDraftState = {
  sourceIdentity: unknown;
  pathKey: string;
  presentationIdentity: string;
  renderedValue: string;
  controlIdentity?: unknown;
  revalidate?: (target: NativeDraftControl) => void;
};

/** Reconcile native drafts and their validity without rewriting unchanged user text. */
export function createNativeDraft(
  read: () => NativeDraftState,
  options: {
    sourceEquals?: (previous: unknown, next: unknown) => boolean;
    preserveFocusedDraft?: boolean;
    onReconciled?: (target: NativeDraftControl, current: NativeDraftState) => void;
  } = {},
) {
  let control: NativeDraftControl | undefined;
  let error: HTMLElement | undefined;
  let previous: NativeDraftState | undefined;
  const setValidity = (target: NativeDraftControl, message: string) => {
    target.setCustomValidity(message);
    target.setAttribute("aria-invalid", String(Boolean(message)));
    if (error) {
      error.hidden = !message;
      error.textContent = message;
    }
    return !message;
  };
  createEffect(read, (current) => {
    if (!control) {
      return;
    }
    if (
      !previous ||
      (!Object.is(previous.sourceIdentity, current.sourceIdentity) &&
        !options.sourceEquals?.(previous.sourceIdentity, current.sourceIdentity)) ||
      previous.pathKey !== current.pathKey ||
      previous.presentationIdentity !== current.presentationIdentity ||
      previous.renderedValue !== current.renderedValue
    ) {
      // Scalar fields retain an uncommitted focused draft through background refreshes.
      if (
        previous &&
        options.preserveFocusedDraft &&
        control.matches(":focus") &&
        control.value !== previous.renderedValue
      ) {
        current.revalidate?.(control);
      } else {
        if (control.value !== current.renderedValue) {
          control.value = current.renderedValue;
        }
        setValidity(control, "");
      }
    } else if (!Object.is(previous.controlIdentity, current.controlIdentity)) {
      current.revalidate?.(control);
    }
    options.onReconciled?.(control, current);
    previous = current;
  });
  return {
    ref(this: void, element: NativeDraftControl) {
      if (control !== element) {
        control = element;
        previous = undefined;
      }
    },
    errorRef(this: void, element: HTMLElement) {
      error = element;
    },
    setValidity,
  };
}
