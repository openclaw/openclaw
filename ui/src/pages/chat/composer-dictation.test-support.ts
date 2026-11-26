export function sessionResult(sessionId = "dictation-1") {
  return {
    sessionId,
    transcriptionSessionId: sessionId,
    audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
  };
}

export function pointer(type: string): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 50,
    clientY: 50,
    button: 0,
  });
  Object.defineProperty(event, "pointerId", { value: 7 });
  return event;
}
