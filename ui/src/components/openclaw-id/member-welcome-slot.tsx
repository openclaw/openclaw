// A newly invited OpenClaw ID member is asked who they are wherever a composer would be: the
// new-session page and the chat page. Until they answer or skip, neither offers a composer.
import type { JSX } from "@solidjs/web";
import { createMemo, lazy, Loading, Show } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { memberWelcomeOwner } from "../../lib/openclaw-id/member-welcome.ts";
import { projectApplicationConfig } from "../../lib/reactive/application.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";

const MemberWelcomeStep = lazy(() => import("./member-welcome-step.tsx"), {
  export: "MemberWelcomeStep",
});

/** The welcome's place in a page; page publications never remount a welcome in progress. */
export function createMemberWelcomeSlot(pageContext: () => ApplicationContext | undefined) {
  // The bootstrap config can arrive after a page mounts, so the Labs switch is read reactively.
  const config = createMemo(() => {
    const context = pageContext();
    // Standalone leaves and tests can supply an application without a config owner.
    return context?.config
      ? { context, view: projectApplicationConfig(context.config) }
      : undefined;
  });
  const enabledContext = createMemo(() => {
    const current = config();
    return current?.view.read().openclawIdEnabled ? current.context : undefined;
  });
  const view = createMemo(() => {
    const context = enabledContext();
    return context
      ? { context, owner: projectOwner(memberWelcomeOwner(context.gateway), (value) => value) }
      : undefined;
  });
  const active = () => (view()?.owner.read().state.kind ?? "none") !== "none";
  const due = createMemo(
    () => {
      const current = view();
      const owner = current?.owner.read();
      return current && owner?.state.kind === "due"
        ? { context: current.context, due: owner.state, answer: () => owner.answer() }
        : undefined;
    },
    { equals: (previous, next) => previous?.due === next?.due },
  );
  const step = () => (
    <Show when={due()} keyed>
      {(welcome) => (
        <Loading>
          <MemberWelcomeStep
            context={welcome.context}
            due={welcome.due}
            onAnswered={welcome.answer}
          />
        </Loading>
      )}
    </Show>
  );
  return {
    /** Whether the welcome stands in for the composer: due, or not yet known on a tunnel connection. */
    active,
    step,
    /** The welcome replaces the page hint and hides starter prompts, which would send a message. */
    options: <T extends { hint?: JSX.Element; hideSecondaryContent?: boolean }>(options: T): T =>
      active() ? { ...options, hint: undefined, hideSecondaryContent: true } : options,
  };
}
