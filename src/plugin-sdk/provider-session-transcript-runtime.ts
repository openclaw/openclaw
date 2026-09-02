import type { AgentHarnessHostCapabilities } from "../agents/harness/host-capability-types.js";
import {
  resolveAgentHarnessTranscriptPrefixCommit,
  type AgentHarnessTranscriptPrefixCommit,
} from "../agents/harness/host-private-capabilities.js";

export function commitProviderSessionTranscriptPrefix(
  params: {
    hostCapabilities: AgentHarnessHostCapabilities;
  } & Parameters<AgentHarnessTranscriptPrefixCommit>[0],
) {
  const { hostCapabilities, baseAnchor, entries } = params;
  const commit = resolveAgentHarnessTranscriptPrefixCommit(hostCapabilities);
  if (!commit) {
    throw new Error("provider transcript commit requires host transcript capability");
  }
  return commit({
    baseAnchor,
    entries: entries.map(({ eventId, identity, message, sourceFingerprint }) => ({
      eventId,
      identity,
      message,
      sourceFingerprint,
    })),
  });
}

export function hasProviderSessionTranscriptCapability(
  hostCapabilities: AgentHarnessHostCapabilities,
): boolean {
  return resolveAgentHarnessTranscriptPrefixCommit(hostCapabilities) !== undefined;
}
