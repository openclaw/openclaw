import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import type { SessionsListResult } from "../../api/types.ts";
import { createParkedProjection } from "../../lib/reactive/parked-projection.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { resolveUiSelectedGlobalAgentId } from "../../lib/sessions/session-key.ts";
import { hasWelcomeRecentSessions } from "../chat/components/chat-welcome.ts";
import { ChatWelcome, type ChatWelcomeProps } from "../chat/components/chat-welcome.tsx";

type WelcomeSessions = {
  readonly state: { readonly result: SessionsListResult | null };
  subscribe: (notify: () => void) => () => void;
};

export type DraftWelcomeOptions = Omit<ChatWelcomeProps, "composer"> & { sessionKey?: string };

export function DraftWelcome(props: {
  sessions: WelcomeSessions | undefined;
  options: DraftWelcomeOptions;
  composer?: JSX.Element;
  assistantNameControl?: JSX.Element;
}) {
  const source = createMemo(() => props.sessions);
  const sessions = createMemo(() => {
    const owner = source();
    return owner ? projectOwner(owner, (current) => current.state.result) : undefined;
  });
  // Legacy render props can publish in-place edits; only selected fields gate work.
  const options = () => props.options;
  const scope = createMemo(
    () => ({
      sessionKey: options().sessionKey,
      defaultAgentId: resolveUiSelectedGlobalAgentId(options().sessionHost ?? {}),
    }),
    {
      equals: (previous, next) =>
        previous.sessionKey === next.sessionKey && previous.defaultAgentId === next.defaultAgentId,
    },
  );
  const excluded = createMemo(() => options().hideSecondaryContent || options().modelSetupRequired);
  const presented = createMemo(() => !excluded() && !options().fadeSecondaryContent);
  // Row publications and selection changes own this fact, never draft text.
  // Park it while faded, then catch up once on reveal.
  const hasRecentSessions = createParkedProjection(() => {
    if (excluded()) {
      return false;
    }
    const selected = scope();
    return hasWelcomeRecentSessions(
      sessions()?.read(),
      selected.sessionKey,
      selected.defaultAgentId,
    );
  }, presented);
  return (
    <ChatWelcome
      {...options()}
      assistantNameControl={props.assistantNameControl}
      composer={props.composer}
      hasRecentSessions={hasRecentSessions()}
    />
  );
}
