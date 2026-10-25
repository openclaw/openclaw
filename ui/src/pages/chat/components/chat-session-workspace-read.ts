import { createDeferred } from "@solidjs/signals";
import { createMemo } from "solid-js";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";

/** Observe the existing workspace request; rendering never admits another RPC. */
export function createSessionWorkspaceRead(workspace: () => SessionWorkspaceProps) {
  const owner = createMemo(() => workspace().readState);
  // Keep the receipt synchronous so a newer read can replace one that is still pending.
  const result = createMemo(() => ({ pending: workspace().readResult }), {
    equals: (previous, next) => previous.pending === next.pending,
  });
  const error = createMemo(() => workspace().error);
  const location = createMemo(() =>
    JSON.stringify([
      workspace().sessionKey,
      workspace().connectionEpoch,
      workspace().browserPath,
      workspace().browserSearch,
    ]),
  );
  const scope = createMemo(() => ({ owner: owner(), location: location() }));
  // Retain the catalog during refresh without holding independently usable file previews.
  const read = createDeferred(async () => {
    const state = owner();
    const pending = result().pending;
    const previousError = error();
    await pending;
    const message = state ? (state.error ?? state.artifacts?.error) : previousError;
    if (message) {
      throw new Error(message);
    }
    return null;
  });
  return { read, scope };
}
