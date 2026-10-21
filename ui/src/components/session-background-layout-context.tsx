import type { JSX } from "@solidjs/web";
import { createContext, createMemo, createStore, onCleanup, useContext } from "solid-js";

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
  // Geometry consumers read immutable registrations outside reactive computations.
  const [targets, setTargets] = createStore<Record<number, SessionBackgroundLayoutTarget>>(
    {},
    { shallow: true },
  );
  let nextRegistration = 0;
  const scope = {
    targets: createMemo(() => Object.values(targets)),
    register(target: SessionBackgroundLayoutTarget) {
      const registration = nextRegistration++;
      setTargets((draft) => {
        draft[registration] = target;
      });
      return () =>
        setTargets((draft) => {
          delete draft[registration];
        });
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
