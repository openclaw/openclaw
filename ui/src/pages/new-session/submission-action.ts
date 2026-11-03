import {
  action,
  affects,
  createMemo,
  createOptimistic,
  onSettled,
  refresh,
  type Accessor,
  type Refreshable,
} from "solid-js";

export type SubmissionPresentation = {
  readonly submissionLifetime: Promise<void>;
  presentSubmit?: (operation: () => Promise<void>) => Promise<void>;
};

/** Owner admission and completion stay outside Solid's presentation transaction. */
export function createPresentationAction<Owner>(
  readOwner: Accessor<Owner>,
  readLifetime: (owner: Owner) => Promise<void>,
  revision: Accessor<unknown>,
  outcome: Refreshable<Accessor<unknown>>,
  onError: (owner: Owner, error: unknown) => void,
) {
  const lifetime = createMemo(
    () => {
      revision();
      const owner = readOwner();
      return { owner, retired: readLifetime(owner) };
    },
    {
      equals: (previous, next) =>
        previous.owner === next.owner && previous.retired === next.retired,
    },
  );
  const presentation = createMemo(() => {
    const scope = lifetime();
    const [saving, setSaving] = createOptimistic(false);
    return { ...scope, saving, setSaving };
  });
  const isCurrent = (view: ReturnType<typeof presentation>) =>
    readOwner() === view.owner && readLifetime(view.owner) === view.retired;
  const present = action(function* (
    view: ReturnType<typeof presentation>,
    pending: Promise<void> | undefined,
  ) {
    if (isCurrent(view)) {
      view.setSaving(true);
      affects(outcome);
    }
    yield Promise.race([pending, view.retired]);
    if (isCurrent(view)) {
      yield refresh(outcome);
    }
  });
  const submit = <Pending extends Promise<void> | undefined>(operation: () => Pending): Pending => {
    const view = presentation();
    const pending = operation();
    // Owner publications must commit before the saving presentation joins this tick.
    void Promise.resolve()
      .then(() => present(view, pending))
      .catch((error: unknown) => {
        if (isCurrent(view)) {
          onError(view.owner, error);
        }
      });
    // Return the consumed operation itself; an async wrapper would create an unhandled rejection for UI callers.
    return pending;
  };
  return { saving: () => presentation().saving(), submit };
}

export function createSubmissionAction(
  readOwner: Accessor<SubmissionPresentation>,
  revision: Accessor<unknown>,
  outcome: Refreshable<Accessor<unknown>>,
  onError: (error: unknown) => void,
) {
  const { saving, submit } = createPresentationAction(
    readOwner,
    (owner) => owner.submissionLifetime,
    revision,
    outcome,
    (_owner, error) => onError(error),
  );
  onSettled(() => {
    const source = readOwner();
    source.presentSubmit = submit;
    return () => {
      if (source.presentSubmit === submit) {
        source.presentSubmit = undefined;
      }
    };
  });
  return saving;
}
