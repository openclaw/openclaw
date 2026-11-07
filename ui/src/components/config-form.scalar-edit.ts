// Scalar edit sessions keep their initial primitive branch while focused rerenders apply patches.
type ScalarControl = HTMLInputElement | HTMLTextAreaElement;
type ScalarValueBranch = "string" | "number" | "boolean";

export type ScalarEditHint = {
  branch?: ScalarValueBranch;
};

type ScalarInputState = {
  edit?: ScalarEditHint;
  pathKey: string;
  presentationIdentity: string;
};

const scalarInputState = new WeakMap<ScalarControl, ScalarInputState>();

export function scalarValueBranch(value: unknown): ScalarValueBranch | undefined {
  const type = typeof value;
  return type === "string" || type === "number" || type === "boolean" ? type : undefined;
}

export function beginScalarEdit(
  target: ScalarControl,
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
  target: ScalarControl,
  initialBranch: ScalarValueBranch | undefined,
): ScalarEditHint {
  return scalarInputState.get(target)?.edit ?? { branch: initialBranch };
}

export function finishScalarEdit(target: ScalarControl): void {
  const state = scalarInputState.get(target);
  if (state) {
    state.edit = undefined;
  }
}

export function syncScalarEditIdentity(
  element: ScalarControl,
  pathKey: string,
  presentationIdentity: string,
): void {
  const previous = scalarInputState.get(element);
  const edit =
    element.ownerDocument.activeElement === element &&
    previous?.pathKey === pathKey &&
    previous.presentationIdentity === presentationIdentity
      ? previous.edit
      : undefined;
  scalarInputState.set(element, {
    edit,
    pathKey,
    presentationIdentity,
  });
}
