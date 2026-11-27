import type { ChatComposerProps } from "./chat-composer-types.ts";

export function isComposerFileReferenceEligible(props: ChatComposerProps): boolean {
  return (
    props.canCompose !== false &&
    props.sessionAdmitted !== false &&
    !props.suggestionComposer &&
    !props.goalDraftMode &&
    props.pluginActionsPresented !== false
  );
}
