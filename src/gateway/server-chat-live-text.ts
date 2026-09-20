type BroadcastDelta = { deltaText: string; replace?: true };

export function resolveBroadcastDelta(params: {
  text: string;
  previousBroadcastText: string | undefined;
}): BroadcastDelta | undefined {
  const previous = params.previousBroadcastText;
  if (previous === undefined) {
    return params.text ? { deltaText: params.text } : undefined;
  }
  if (!params.text.startsWith(previous)) {
    return { deltaText: params.text, replace: true };
  }
  const deltaText = params.text.slice(previous.length);
  return deltaText ? { deltaText } : undefined;
}
