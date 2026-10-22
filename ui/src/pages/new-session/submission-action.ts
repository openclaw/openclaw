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

/** Submission admission and completion stay outside Solid's presentation transaction. */
export function createSubmissionAction(
  readOwner: Accessor<SubmissionPresentation>,
  revision: Accessor<unknown>,
  outcome: Refreshable<Accessor<unknown>>,
  onError: (error: unknown) => void,
) {
  const owner = createMemo(readOwner);
  const lifetime = createMemo(
    () => {
      revision();
      return { promise: owner().submissionLifetime };
    },
    { equals: (previous, next) => previous.promise === next.promise },
  );
  const presentation = createMemo(() => {
    const retired = lifetime().promise;
    const [saving, setSaving] = createOptimistic(false);
    return { owner: owner(), retired, saving, setSaving };
  });
  const isCurrent = (view: ReturnType<typeof presentation>) =>
    owner() === view.owner && view.owner.submissionLifetime === view.retired;
  const present = action(function* (view: ReturnType<typeof presentation>, pending: Promise<void>) {
    if (isCurrent(view)) {
      view.setSaving(true);
      affects(outcome);
    }
    yield Promise.race([pending, view.retired]);
    if (isCurrent(view)) {
      yield refresh(outcome);
    }
  });
  const submit = (operation: () => Promise<void>) => {
    const view = presentation();
    const pending = operation();
    // Owner publications must commit before the saving presentation joins this tick.
    void Promise.resolve()
      .then(() => present(view, pending))
      .catch((error: unknown) => {
        if (isCurrent(view)) {
          onError(error);
        }
      });
    // Return the consumed operation itself; an async wrapper would create an unhandled rejection for UI callers.
    return pending;
  };
  onSettled(() => {
    const source = owner();
    source.presentSubmit = submit;
    return () => {
      if (source.presentSubmit === submit) {
        source.presentSubmit = undefined;
      }
    };
  });
  return () => presentation().saving();
}
