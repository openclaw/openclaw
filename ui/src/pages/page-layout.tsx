import type { JSX } from "@solidjs/web";
import { untrack, useContext } from "solid-js";
import { shellLayoutOwnerForHost } from "../app/shell-layout-owner.ts";
import { ShellLayoutProvider } from "../app/shell-layout-traits-solid.tsx";

/** Lit route hosts need the same layout scope that the Solid shell provides. */
export function PageLayout(props: { host: Element; children: JSX.Element }) {
  // A bridge host keeps its identity for the lifetime of this mounted root.
  const host = untrack(() => props.host);
  const inherited = useContext(ShellLayoutProvider);
  const owner = inherited?.owner ?? shellLayoutOwnerForHost(host);
  return (
    <ShellLayoutProvider value={inherited ?? (owner ? { owner, host } : null)}>
      {props.children}
    </ShellLayoutProvider>
  );
}
