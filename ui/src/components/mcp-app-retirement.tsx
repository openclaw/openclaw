import type { JSX } from "@solidjs/web";
import { createMemo, createRoot, createSignal, getOwner, onCleanup, runWithOwner } from "solid-js";
import { createMcpAppUnmountGate } from "./mcp-app-unmount.ts";

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
  const gate = createMcpAppUnmountGate<JSX.Element>(() => setRevision((value) => value + 1));
  const content = createMemo(() => {
    revision();
    const identity = props.identity;
    const renderChild = props.children;
    return gate.render(
      identity,
      () => {
        disposeRendered();
        // The gate, rather than its recomputing memo, owns the accepted child lifetime.
        return runWithOwner(owner, () =>
          createRoot((dispose) => {
            disposeChild = dispose;
            return renderChild(identity);
          }),
        );
      },
      props.roots,
      { retainRenderedValue: true },
    );
  });
  return <>{content()}</>;
}
