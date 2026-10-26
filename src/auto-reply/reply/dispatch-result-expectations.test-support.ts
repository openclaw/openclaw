export function expectedNoQueuedReplyResult() {
  return {
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  };
}
