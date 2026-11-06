import { createMemo, createSignal } from "solid-js";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import type { DetailsSectionAvailability } from "./chat-details-presence.tsx";
import { readDetailsViewer } from "./chat-details-viewer.ts";

/** Scope-owned view projection; the inventory remains the only availability decision owner. */
export function createDetailsAvailabilityProjection(
  readPresentation: () => unknown,
  readGateway: () => ApplicationGateway | undefined,
  readDesktop: () => boolean,
) {
  const context = useOptionalApplication();
  const viewerGateway = context ? projectGateway(context.gateway) : undefined;
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
  const [facts, setFacts] = createSignal<
    Partial<Record<DetailsSectionAvailability["section"], DetailsSectionAvailability>>
  >(() => {
    identity();
    return {};
  });
  const [hasContent, onContentChange] = createSignal<boolean | undefined>(() => {
    readPresentation();
    return undefined;
  });
  return {
    identity,
    hasContent,
    onContentChange,
    facts: () => {
      const current = facts();
      return {
        automation:
          current.automation?.identity === identity() ? current.automation.available : undefined,
        processes:
          current.processes?.identity === identity() ? current.processes.available : undefined,
        viewer: readDetailsViewer(viewerGateway?.read().snapshot.selfUser, Boolean(viewerGateway)),
      };
    },
    report: (next: DetailsSectionAvailability) => {
      if (next.identity === identity()) {
        setFacts((current) => ({ ...current, [next.section]: next }));
      }
    },
  };
}
