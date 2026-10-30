/**
 * In-page prelude for platforms that opt into live ownership checks during the shared status tail's
 * media routing. It opens the `audioOutputRouting` block that the tail closes after routing.
 */
export function createMeetingRoutingOwnershipSource(params: {
  liveOwnershipSource: string;
  meetingGlobal: string;
}): string {
  return `
  const routingSources = [];
  const routingBridges = [];
  const recheckAudioOwnership = () => {
    if (${params.liveOwnershipSource}) return true;
    // A session that took over the page now owns this media; undoing our pass would clobber its routing.
    const replacedBy = window[${params.meetingGlobal}]?.sessionId;
    if (canMutateSession && !(replacedBy && replacedBy !== sessionId)) {
      routingBridges.forEach((entry) => retireAudioBridge(entry, false));
      retireOwnedAudioBridges();
      routingSources.forEach((source) => {
        restoreAudioBridgeSource(source);
        // A direct sink change can finish after ownership moved; return that exact source's playback.
        if (bridgeSourceMatches(source.element, source) && source.element.sinkId !== source.sinkId) {
          const pending = (window.__openclawMeetingSinkRestores ||= new Set());
          const restore = source.element
            .setSinkId(source.sinkId)
            .catch(() => {})
            .finally(() => pending.delete(restore));
          pending.add(restore);
        }
      });
    }
    audioOutputRouted = false;
    audioOutputRouteRetryable = true;
    notes.push("Call ownership changed during audio routing; stopped this pass.");
    return false;
  };
  // Restores from an earlier ownership loss stay in flight until they settle, so every overlapping
  // pass waits for them before routing again.
  if (window.__openclawMeetingSinkRestores?.size) {
    await Promise.allSettled([...window.__openclawMeetingSinkRestores]);
  }
  audioOutputRouting: {`;
}
