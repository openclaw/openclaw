import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, untrack } from "solid-js";
import type { SessionsListResult } from "../../api/types.ts";
import { i18nRevision } from "../../lib/reactive/i18n.ts";
import { createParkedProjection } from "../../lib/reactive/parked-projection.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { resolveUiSelectedGlobalAgentId } from "../../lib/sessions/session-key.ts";
import { prepareWelcomeRecentSessions } from "../chat/components/chat-welcome.ts";
import { ChatWelcome, type ChatWelcomeProps } from "../chat/components/chat-welcome.tsx";

type WelcomeSessions = {
  readonly state: { readonly result: SessionsListResult | null };
  subscribe: (notify: () => void) => () => void;
};

export function DraftWelcome(props: {
  sessions: WelcomeSessions | undefined;
  options: Omit<ChatWelcomeProps, "composer">;
  composer?: JSX.Element;
}) {
  const source = createMemo(() => props.sessions);
  const sessions = projectSource(untrack(source), {
    read: (owner) => owner?.state.result,
    subscribe: (owner, notify) => owner?.subscribe(notify) ?? (() => {}),
    equality: "revision",
  });
  createEffect(source, (next) => sessions.replaceSource(next));
  // Legacy render props can publish in-place edits; only selected fields gate work.
  const options = createMemo(() => props.options, { equals: false });
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
  // Row publications and selection/locale changes own recents, never draft text.
  // Park immutable display facts while faded, then catch up once on reveal.
  const recents = createParkedProjection(() => {
    if (excluded()) {
      return [];
    }
    i18nRevision();
    const selected = scope();
    return prepareWelcomeRecentSessions(
      sessions.read(),
      selected.sessionKey,
      selected.defaultAgentId,
    );
  }, presented);
  return <ChatWelcome {...options()} composer={props.composer} preparedRecents={recents()} />;
}
