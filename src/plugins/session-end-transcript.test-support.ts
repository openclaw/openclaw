import type {
  PluginHookSessionContext,
  SessionEndTranscriptSource,
} from "./session-end-transcript.js";

export function readAttachedSessionEndTranscriptSourceForTest(
  context: PluginHookSessionContext,
): SessionEndTranscriptSource {
  const sourceSymbol = Object.getOwnPropertySymbols(context).find(
    (symbol) => symbol.description === "openclaw.sessionEndTranscriptSource",
  );
  if (!sourceSymbol) {
    throw new Error("session_end transcript source was not attached");
  }
  // SAFETY: the private symbol description identifies the source installed by the production owner.
  return Reflect.get(context, sourceSymbol) as SessionEndTranscriptSource;
}
