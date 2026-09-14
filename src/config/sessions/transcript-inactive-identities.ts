// Cached channel messages outlive the transcript branch they were consumed into:
// a rewind or branch switch rotates the session to a new leaf, but channel caches
// key on chat identity and keep serving the cut turns. These identities let the
// inbound context merge drop cached window entries whose transcript turn is no
// longer on the active path, without touching the cache itself.
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  scopeLegacySessionKeyToAgent,
} from "../../routing/session-key.js";
import { resolveDefaultSessionStorePath } from "./paths.js";
import { loadSessionEntryReadOnly, loadTranscriptEvents } from "./session-accessor.js";
import {
  isSessionTranscriptLeafControl,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

export type SessionInactiveContextIdentities = {
  /** Entry ids of user/assistant turns cut from the active path. */
  transcriptEntryIds: ReadonlySet<string>;
  /** Lowercased channel id -> transport message ids of cut user turns. */
  channelMessageIds: ReadonlyMap<string, ReadonlySet<string>>;
};

const EMPTY_IDENTITIES: SessionInactiveContextIdentities = {
  transcriptEntryIds: new Set<string>(),
  channelMessageIds: new Map<string, ReadonlySet<string>>(),
};

export async function readInactiveSessionContextIdentities(params: {
  agentId?: string;
  sessionKey: string;
  storePath?: string;
}): Promise<SessionInactiveContextIdentities> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return EMPTY_IDENTITIES;
  }
  const requestedAgentId = params.agentId?.trim() ? normalizeAgentId(params.agentId) : undefined;
  const sessionKeyAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  // The canonical read path throws on an explicit/key owner mismatch; abstain
  // here and let that path report it.
  if (
    requestedAgentId &&
    sessionKeyAgentId &&
    requestedAgentId !== normalizeAgentId(sessionKeyAgentId)
  ) {
    return EMPTY_IDENTITIES;
  }
  const agentId = requestedAgentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const scopedSessionKey = scopeLegacySessionKeyToAgent({ agentId, sessionKey }) ?? sessionKey;
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(agentId);
  const entry = loadSessionEntryReadOnly({ agentId, sessionKey: scopedSessionKey, storePath });
  if (!entry?.sessionId) {
    return EMPTY_IDENTITIES;
  }
  const events = await loadTranscriptEvents({
    agentId,
    sessionId: entry.sessionId,
    sessionKey: scopedSessionKey,
    storePath,
  });
  const tree = scanSessionTranscriptTree(events);
  // No leaf control means no rewind/switch ever happened, so every event is on
  // the only branch; an invalid tree gives no trustworthy membership either way.
  if (!tree.hasLeafControl || tree.hasInvalidLeafControl) {
    return EMPTY_IDENTITIES;
  }
  const activePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  if (activePath.length === 0 && tree.nodes.length > 0) {
    return EMPTY_IDENTITIES;
  }
  const activeIds = new Set(activePath.map((node) => node.id));
  const transcriptEntryIds = new Set<string>();
  const channelMessageIds = new Map<string, Set<string>>();
  for (const node of tree.nodes) {
    if (activeIds.has(node.id) || isSessionTranscriptLeafControl(node.entry)) {
      continue;
    }
    const message = asRecord(asRecord(node.entry)?.message);
    if (message?.role !== "user" && message?.role !== "assistant") {
      continue;
    }
    transcriptEntryIds.add(node.id);
    const transport = asRecord(asRecord(message.__openclaw)?.transport);
    const channel = normalizeOptionalString(transport?.channel)?.toLowerCase();
    const messageId = normalizeOptionalString(transport?.messageId);
    if (!channel || !messageId) {
      continue;
    }
    const ids = channelMessageIds.get(channel) ?? new Set<string>();
    ids.add(messageId);
    channelMessageIds.set(channel, ids);
  }
  if (transcriptEntryIds.size === 0 && channelMessageIds.size === 0) {
    return EMPTY_IDENTITIES;
  }
  return { transcriptEntryIds, channelMessageIds };
}
