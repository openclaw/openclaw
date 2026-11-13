import { readPersistedMediaFacts } from "../media/media-facts.js";
import { notifyCollectedInputPersisted } from "./user-turn-transcript-admission.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

export function createUserTurnPersistedNotifier(params: {
  pendingInputSources?: readonly UserTurnTranscriptRecorder[];
  pendingInputSourcesAreLossless?: true;
  committed: () => PersistedUserTurnMessage | undefined;
  fallback: () => PersistedUserTurnMessage | undefined;
  original: () => [PersistedUserTurnMessage | undefined, boolean];
  onMessagePersisted?: (message: PersistedUserTurnMessage) => void | Promise<void>;
  onApprovedMessagePersisted?: (message: PersistedUserTurnMessage) => void | Promise<void>;
  onError: (error: unknown) => void;
}) {
  let notified = false;
  let approvedNotified = false;
  const notify = (
    callback: (message: PersistedUserTurnMessage) => void | Promise<void>,
    message: PersistedUserTurnMessage,
  ) => {
    try {
      void Promise.resolve(callback(message)).catch(params.onError);
    } catch (error) {
      params.onError(error);
    }
  };
  return (persistedMessage?: PersistedUserTurnMessage) => {
    const approved = persistedMessage ?? params.committed();
    const message = approved ?? params.fallback();
    if (!message) {
      return;
    }
    const [original, blocked] = params.original();
    if (approved && !blocked && !approvedNotified) {
      approvedNotified = true;
      notifyCollectedInputPersisted(
        params.pendingInputSources,
        approved,
        original,
        params.pendingInputSourcesAreLossless === true,
      );
      if (params.onApprovedMessagePersisted) {
        notify(params.onApprovedMessagePersisted, approved);
      }
    }
    if (!notified && params.onMessagePersisted) {
      notified = true;
      notify(params.onMessagePersisted, message);
    }
  };
}

/** Preserve only source media also represented by the committed aggregate. */
export function createCollectedInputNotifier(
  original: () => [PersistedUserTurnMessage | undefined, boolean],
  notify: (message: PersistedUserTurnMessage) => void,
) {
  return (approved: PersistedUserTurnMessage, unchanged: boolean) => {
    const [source, blocked] = original();
    if (!source || blocked) {
      return;
    }
    const approvedKeys = new Set(
      (readPersistedMediaFacts(approved) ?? []).flatMap((fact) => fact.url ?? fact.path ?? []),
    );
    const media = (readPersistedMediaFacts(source) ?? []).filter((fact) =>
      approvedKeys.has(fact.url ?? fact.path ?? ""),
    );
    const metadata = source["__openclaw"];
    notify({
      ...source,
      content: unchanged ? source.content : approved.content,
      ...(metadata ? { __openclaw: { ...metadata, media } } : {}),
    });
  };
}
