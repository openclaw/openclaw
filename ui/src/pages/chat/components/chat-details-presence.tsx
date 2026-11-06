import type { JSX } from "@solidjs/web";
import { createContext, onSettled, Show, useContext } from "solid-js";

export type DetailsSectionAvailability = {
  identity: unknown;
  section: "automation" | "processes";
  available: boolean;
};
const DetailsPresence = createContext<{
  register: () => () => void;
  identity: () => unknown;
  reportSection: (fact: DetailsSectionAvailability) => void;
} | null>(null);

export function useDetailsAvailability() {
  return useContext(DetailsPresence);
}

/** Project settled owner facts; no fact is published while the owner binding is unresolved. */
export function ChatDetailsSectionAvailability(props: {
  fact: DetailsSectionAvailability | undefined;
}) {
  const owner = useDetailsAvailability();
  return (
    <Show when={owner && props.fact} keyed>
      {(fact) => {
        onSettled(() => owner?.reportSection(fact));
        return null;
      }}
    </Show>
  );
}

/** Section owners register only while their rendered content exists. */
export function registerDetailsDesktopSection() {
  const register = useContext(DetailsPresence)?.register;
  onSettled(() => register?.());
}

export function ChatDetailsDesktopPresence() {
  registerDetailsDesktopSection();
  return null;
}

export function ChatDetailsPresence(props: {
  children: JSX.Element;
  onContentChange?: (hasContent: boolean) => void;
  identity?: unknown;
  onSectionAvailability?: (fact: DetailsSectionAvailability) => void;
}) {
  let sections = 0;
  const changed = () => props.onContentChange?.(sections > 0);
  const register = () => {
    sections += 1;
    changed();
    return () => {
      sections -= 1;
      changed();
    };
  };
  onSettled(() => {
    changed();
    return () => props.onContentChange?.(false);
  });
  const owner = {
    register,
    identity: () => props.identity,
    reportSection: (fact: DetailsSectionAvailability) => props.onSectionAvailability?.(fact),
  };
  return <DetailsPresence value={owner}>{props.children}</DetailsPresence>;
}
