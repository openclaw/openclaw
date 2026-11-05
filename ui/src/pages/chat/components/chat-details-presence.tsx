import type { JSX } from "@solidjs/web";
import { createContext, createMemo, createSignal, onSettled, Show, useContext } from "solid-js";
import type { ApplicationGateway } from "../../../app/gateway.ts";

export type DetailsAutomationAvailability = { identity: unknown; available: boolean };
/** Scope-owned view projection; the inventory remains the only availability decision owner. */
export function createDetailsAvailabilityProjection(
  readPresentation: () => unknown,
  readGateway: () => ApplicationGateway | undefined,
  readDesktop: () => boolean,
) {
  const identity = createMemo(
    () => {
      const gateway = readGateway();
      return {
        presentation: readPresentation(),
        gateway,
        client: gateway?.snapshot.client,
        desktop: readDesktop(),
      };
    },
    {
      equals: (a, b) =>
        a.presentation === b.presentation &&
        a.gateway === b.gateway &&
        a.client === b.client &&
        a.desktop === b.desktop,
    },
  );
  const [fact, setFact] = createSignal<DetailsAutomationAvailability | undefined>(() => {
    identity();
    return undefined;
  });
  const [hasContent, onContentChange] = createSignal<boolean | undefined>(() => {
    readPresentation();
    return undefined;
  });
  return {
    identity,
    hasContent,
    onContentChange,
    available: () => {
      const current = fact();
      return current && current.identity === identity() ? current.available : undefined;
    },
    report: (next: DetailsAutomationAvailability) => {
      if (next.identity === identity()) {
        setFact(next);
      }
    },
  };
}

const DetailsPresence = createContext<{
  register: () => () => void;
  identity: () => unknown;
  reportAutomation: (fact: DetailsAutomationAvailability) => void;
} | null>(null);

export function useDetailsAvailability() {
  return useContext(DetailsPresence);
}

/** Project settled owner facts; no fact is published while the owner binding is unresolved. */
export function ChatDetailsAutomationAvailability(props: {
  fact: DetailsAutomationAvailability | undefined;
}) {
  const owner = useDetailsAvailability();
  return (
    <Show when={owner && props.fact} keyed>
      {(fact) => {
        onSettled(() => owner?.reportAutomation(fact));
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
  onAutomationAvailability?: (fact: DetailsAutomationAvailability) => void;
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
    reportAutomation: (fact: DetailsAutomationAvailability) =>
      props.onAutomationAvailability?.(fact),
  };
  return <DetailsPresence value={owner}>{props.children}</DetailsPresence>;
}
