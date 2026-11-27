import type { FileReferenceSource } from "../composer-file-references.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function isComposerFileReferenceEligible(props: ChatComposerProps): boolean {
  return (
    props.canCompose !== false &&
    props.sessionAdmitted !== false &&
    !props.suggestionComposer &&
    !props.goalDraftMode &&
    props.pluginActionsPresented !== false
  );
}

export function readComposerFileReferenceSource(
  props: ChatComposerProps,
  state: Pick<ChatComposerState, "editRevision" | "composerTextarea">,
): FileReferenceSource {
  const client = props.gatewayClient ?? null;
  return {
    client,
    connected: props.connected,
    sessionKey: props.sessionKey,
    agentId: props.currentAgentId,
    draft: props.getDraft?.() ?? props.draft,
    revision: state.editRevision,
    target: state.composerTextarea,
    // The opt-in control explicitly selects the English command grammar.
    locale: "en-US",
    eligible: isComposerFileReferenceEligible(props),
    request: (params) =>
      client
        ? client.request("sessions.files.references", params)
        : Promise.reject(new Error("File reference provider unavailable")),
  };
}
