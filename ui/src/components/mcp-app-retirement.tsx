import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Show } from "solid-js";
import { createMcpAppUnmountGate } from "./mcp-app-unmount.ts";

/** Keep the old child tree connected until its Apps have acknowledged retirement. */
export function McpAppRetirement(props: {
  identity: string;
  roots: () => Iterable<ParentNode>;
  children: (identity: string) => JSX.Element;
}) {
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const gate = createMcpAppUnmountGate<{ identity: string }>(() =>
    setRevision((value) => value + 1),
  );
  const content = createMemo(() => {
    revision();
    const identity = props.identity;
    return gate.render(identity, () => ({ identity }), props.roots, { retainRenderedValue: true });
  });
  return (
    <Show when={content()} keyed>
      {(accepted) => props.children(accepted.identity)}
    </Show>
  );
}
