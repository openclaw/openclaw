import type { JSX } from "@solidjs/web";
import {
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  untrack,
} from "solid-js";
import { McpAppUnmountGate } from "./mcp-app-unmount.ts";

/** Keep the old child tree connected until its Apps have acknowledged retirement. */
export function McpAppRetirement(props: {
  identity: string;
  roots: () => Iterable<ParentNode>;
  children: (identity: string) => JSX.Element;
}) {
  const owner = getOwner();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  let disposeChild: (() => void) | undefined;
  const disposeRendered = () => {
    const dispose = disposeChild;
    disposeChild = undefined;
    dispose?.();
  };
  onCleanup(disposeRendered);
  const gate = new McpAppUnmountGate<JSX.Element>({
    requestUpdate: () => setRevision((value) => value + 1),
  });
  const content = createMemo(() => {
    revision();
    const identity = props.identity;
    return gate.render(
      identity,
      () => {
        disposeRendered();
        // The gate, rather than its recomputing memo, owns the accepted child lifetime.
        return runWithOwner(owner, () =>
          createRoot((dispose) => {
            disposeChild = dispose;
            return untrack(() => props.children(identity));
          }),
        );
      },
      props.roots,
      { retainRenderedValue: true },
    );
  });
  return <>{content()}</>;
}
