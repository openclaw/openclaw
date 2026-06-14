// Sticky record of channels that have registered a pin-from-here mirror
// dispatcher at any point this process. The echo-admission gate uses it to fail
// closed: a mirror-capable channel must keep its echo path gated even while its
// admission predicate is momentarily absent (an account stop/reload unregisters
// the dispatcher and the predicate together). Without this, an echo during that
// window would hit the "no predicate registered -> admit-all" path and the raw
// echo could leak to a now-revoked destination. It is intentionally sticky and
// never cleared in production: erring toward NOT delivering is the safe direction
// for revocation. This module imports nothing so both mirror-dispatch (which
// marks) and channel-admission (which reads) can use it without an import cycle.
const mirrorCapableChannels = new Set<string>();

/** Mark a channel as mirror-capable (called when it registers a mirror dispatcher). */
export function markChannelMirrorCapable(channel: string): void {
  mirrorCapableChannels.add(channel);
}

/** Whether the channel has ever been mirror-capable this process. */
export function isChannelMirrorCapable(channel: string): boolean {
  return mirrorCapableChannels.has(channel);
}

export function resetChannelMirrorCapabilityForTest(): void {
  mirrorCapableChannels.clear();
}
