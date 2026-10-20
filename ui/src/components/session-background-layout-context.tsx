import type { JSX } from "@solidjs/web";
import { createContext, createSignal, onCleanup, useContext } from "solid-js";

export type SessionBackgroundLayoutTarget = {
  kind: "composer" | "welcome" | "scroll";
  element: HTMLElement;
};

export const SessionBackgroundLayoutContext = createContext<{
  targets: () => readonly SessionBackgroundLayoutTarget[];
  register: (target: SessionBackgroundLayoutTarget) => () => void;
} | null>(null);

/** Each draft owns the geometry used by its background. */
export function SessionBackgroundLayoutScope(props: { children: JSX.Element }) {
  const [targets, setTargets] = createSignal<readonly SessionBackgroundLayoutTarget[]>([]);
  const scope = {
    targets,
    register(target: SessionBackgroundLayoutTarget) {
      setTargets((current) => [...current, target]);
      return () => setTargets((current) => current.filter((entry) => entry !== target));
    },
  };
  return (
    <SessionBackgroundLayoutContext value={scope}>{props.children}</SessionBackgroundLayoutContext>
  );
}

/** Capture the scope during setup; attach the actual element through its renderer ref. */
export function createBackgroundLayoutRef(kind: SessionBackgroundLayoutTarget["kind"]) {
  const scope = useContext(SessionBackgroundLayoutContext);
  let release: (() => void) | undefined;
  onCleanup(() => release?.());
  return (element: HTMLElement) => {
    release?.();
    release = scope?.register({ kind, element });
  };
}
