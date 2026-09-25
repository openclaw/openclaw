// Scalar edit sessions keep their initial primitive branch while focused rerenders apply patches.
type ScalarValueBranch = "string" | "number" | "boolean";

export type ScalarEditHint = {
  branch?: ScalarValueBranch;
};

type ScalarEditState = {
  edit?: ScalarEditHint;
  pathKey: string;
  presentationIdentity: string;
};

const scalarEditState = new WeakMap<HTMLInputElement, ScalarEditState>();

export function scalarValueBranch(value: unknown): ScalarValueBranch | undefined {
  const type = typeof value;
  return type === "string" || type === "number" || type === "boolean" ? type : undefined;
}

export function syncScalarEditIdentity(
  element: Element | undefined,
  pathKey: string,
  presentationIdentity: string,
): void {
  if (!(element instanceof HTMLInputElement)) {
    return;
  }
  const previous = scalarEditState.get(element);
  const preserveEdit =
    previous?.edit !== undefined &&
    element.ownerDocument.activeElement === element &&
    previous.pathKey === pathKey &&
    previous.presentationIdentity === presentationIdentity;
  scalarEditState.set(element, {
    edit: preserveEdit ? previous.edit : undefined,
    pathKey,
    presentationIdentity,
  });
}

export function beginScalarEdit(
  target: HTMLInputElement,
  initialBranch: ScalarValueBranch | undefined,
): ScalarEditHint {
  const state = scalarEditState.get(target);
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
  return scalarEditState.get(target)?.edit ?? { branch: initialBranch };
}

export function finishScalarEdit(target: HTMLInputElement): void {
  const state = scalarEditState.get(target);
  if (state) {
    state.edit = undefined;
  }
}

export function finishScalarEditFromEvent(event: Event): void {
  if (event.currentTarget instanceof HTMLInputElement) {
    finishScalarEdit(event.currentTarget);
  }
}

const scalarInputState = new WeakMap<
  HTMLInputElement,
  {
    controlIdentity: unknown;
    sourceIdentity: unknown;
    pathKey: string;
    presentationIdentity: string;
    renderedValue: string;
  }
>();

export function setControlValidity(target: HTMLInputElement, message: string): boolean {
  target.setCustomValidity(message);
  target.setAttribute("aria-invalid", String(Boolean(message)));
  const error = target.closest(".settings-row")?.querySelector<HTMLElement>(".cfg-field__error");
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
    controlIdentity,
    sourceIdentity,
    pathKey,
    presentationIdentity,
    renderedValue,
  });
}
