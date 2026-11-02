import type { JSX } from "@solidjs/web";
import {
  createDeferred,
  createMemo,
  Errored,
  isPending,
  latest,
  Loading,
  type Accessor,
} from "solid-js";
import type { PageReadResult } from "../../lib/page-request.ts";

export type UsageRead = Accessor<PageReadResult | undefined>;

export function createUsageRead(
  source: () => Promise<PageReadResult> | null,
  readError: () => string | null,
): UsageRead {
  // A bare Promise return would make this identity memo another async read.
  const receipt = createMemo(() => ({ value: latest(source) }), {
    equals: (before, after) => before.value === after.value,
  });
  const error = createMemo(() => latest(readError));
  // The receipt only controls status. Deferring it keeps query and selection
  // publications independent while an earlier read is still settling.
  return createDeferred<PageReadResult | undefined>(
    () => {
      const pending = latest(receipt).value;
      const message = latest(error);
      const recordedError = message ? { error: new Error(message) } : null;
      return pending
        ? Promise.resolve(pending).then((result) => result ?? recordedError)
        : recordedError;
    },
    { loadingValue: undefined },
  );
}

/** Only this status slot consumes failures; accepted charts and rows stay mounted. */
export function UsageReadStatus(props: { read: UsageRead; children: () => JSX.Element }) {
  const completion = () => {
    const result = latest(props.read);
    if (result) {
      throw result.error;
    }
    return null;
  };
  return (
    <Loading fallback={props.children()}>
      <Errored fallback={() => props.children()}>
        {completion()}
        {props.children()}
      </Errored>
    </Loading>
  );
}

export function UsagePending(props: {
  read: UsageRead;
  children: (pending: Accessor<boolean>) => JSX.Element;
}) {
  // The native loading value makes this probe always readable. Keep the owner
  // props outside Loading so new query and selection facts land immediately.
  const pending = () => isPending(props.read) || latest(props.read) === undefined;
  return <>{props.children(pending)}</>;
}
