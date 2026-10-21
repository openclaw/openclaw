import { Errored, Loading, onCleanup, type ParentProps } from "solid-js";
import { createIdleImport } from "../lib/idle-import.ts";

/** Keep mounted lazy reads retryable through the sidebar's idle/online loader. */
export function createSidebarRendererLoader<T>(importModule: () => Promise<T>) {
  const resets = new Set<() => void>();
  const importer = createIdleImport(importModule, () => {
    // Reset replaces fallback registrations while this set is being traversed.
    const mountedResets = [...resets];
    for (const reset of mountedResets) {
      reset();
    }
  });

  function Boundary(props: ParentProps) {
    return (
      <Errored
        fallback={(_error, reset) => {
          resets.add(reset);
          // This registration belongs to the error fallback's reactive run.
          onCleanup(() => resets.delete(reset));
          return null;
        }}
      >
        <Loading fallback={null}>{props.children}</Loading>
      </Errored>
    );
  }

  return { ...importer, Boundary };
}
