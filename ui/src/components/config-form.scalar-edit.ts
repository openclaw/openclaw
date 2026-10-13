// Scalar edit sessions keep their initial primitive branch while focused rerenders apply patches.
type ScalarValueBranch = "string" | "number" | "boolean";

export type ScalarEditHint = {
  branch?: ScalarValueBranch;
};

type ScalarInputState = {
  edit?: ScalarEditHint;
  controlIdentity: unknown;
  sourceIdentity: unknown;
  pathKey: string;
  presentationIdentity: string;
  renderedValue: string;
};

const scalarInputState = new WeakMap<HTMLInputElement, ScalarInputState>();

export function scalarValueBranch(value: unknown): ScalarValueBranch | undefined {
  const type = typeof value;
  return type === "string" || type === "number" || type === "boolean" ? type : undefined;
}

export function beginScalarEdit(
  target: HTMLInputElement,
  initialBranch: ScalarValueBranch | undefined,
): ScalarEditHint {
  const state = scalarInputState.get(target);
  if (!state) {
    return { branch: initialBranch };
  }
  state.edit ??= { branch: initialBranch };
  return state.edit;
}

export function scalarEditHintForInput(
  target: HTMLInputElement,
  initialBranch: ScalarValueBranch | undefined,
): ScalarEditHint {
  return scalarInputState.get(target)?.edit ?? { branch: initialBranch };
}

export function finishScalarEdit(target: HTMLInputElement): void {
  const state = scalarInputState.get(target);
  if (state) {
    state.edit = undefined;
  }
}

export function setControlValidity(
  target: HTMLInputElement | HTMLTextAreaElement,
  message: string,
  errorContainer = ".settings-row",
): boolean {
  target.setCustomValidity(message);
  target.setAttribute("aria-invalid", String(Boolean(message)));
  const error = target.closest(errorContainer)?.querySelector<HTMLElement>(".cfg-field__error");
  if (error) {
    error.hidden = !message;
    error.textContent = message;
  }
  return !message;
}

export function syncScalarInputIdentity(
  element: Element | undefined,
  controlIdentity: unknown,
  sourceIdentity: unknown,
  pathKey: string,
  presentationIdentity: string,
  renderedValue: string,
  revalidate: (target: HTMLInputElement) => void,
): void {
  if (!(element instanceof HTMLInputElement)) {
    return;
  }
  const previous = scalarInputState.get(element);
  const edit =
    element.ownerDocument.activeElement === element &&
    previous?.pathKey === pathKey &&
    previous.presentationIdentity === presentationIdentity
      ? previous.edit
      : undefined;
  if (previous) {
    if (
      !Object.is(previous.sourceIdentity, sourceIdentity) ||
      previous.pathKey !== pathKey ||
      previous.presentationIdentity !== presentationIdentity ||
      previous.renderedValue !== renderedValue
    ) {
      // A focused input whose DOM value drifted from the last render holds an
      // in-flight edit the model has not committed yet (mid-keystroke or
      // mid-automation fill). Resetting it here silently eats that input when
      // a background config refresh lands; blurred fields keep the
      // authoritative-reset contract.
      if (element.matches(":focus") && element.value !== previous.renderedValue) {
        revalidate(element);
      } else {
        element.value = renderedValue;
        setControlValidity(element, "");
      }
    } else if (!Object.is(previous.controlIdentity, controlIdentity)) {
      revalidate(element);
    }
  }
  scalarInputState.set(element, {
    edit,
    controlIdentity,
    sourceIdentity,
    pathKey,
    presentationIdentity,
    renderedValue,
  });
}
