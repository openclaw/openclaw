const SESSION_TRANSCRIPT_LISTENERS = new Set();
export function onSessionTranscriptUpdate(listener) {
    SESSION_TRANSCRIPT_LISTENERS.add(listener);
    return () => {
        SESSION_TRANSCRIPT_LISTENERS.delete(listener);
    };
}
export function emitSessionTranscriptUpdate(sessionFile) {
    const trimmed = sessionFile.trim();
    if (!trimmed) {
        return;
    }
    const update = { sessionFile: trimmed };
    for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
        listener(update);
    }
}
