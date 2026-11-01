import type { AgentMessage, SessionTreeEntry } from "@openclaw/agent-core";
import { projectSessionEntryMessage } from "../../../packages/agent-core/src/harness/session/session.js";
import { classifyToolUseResultPairing } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { SessionModelContextLimits } from "./session-history-read.types.js";
import {
  PREFIX_TOOL_OWNER,
  type ModelContextPairingFacts,
} from "./session-model-context-pairing.js";

export type ContextEntry = SessionTreeEntry & { seq: number };
export type ModelContextRequest = {
  entry: ContextEntry;
  /** The payload stays at its acceptance row; this marker owns its model-visible position. */
  placement?: ContextEntry;
  omitCheckpoint: boolean;
  toolResultOmission?: string;
};

export type ModelContextPrefix = {
  count: number;
  bytes: number;
  hasUser: boolean;
  pairing: ModelContextPairingFacts;
};

function readToolResultOwners(messages: readonly AgentMessage[]): ModelContextPairingFacts {
  const owners = new Map<AgentMessage, Extract<AgentMessage, { role: "assistant" }>>();
  for (const frame of classifyToolUseResultPairing(messages)) {
    for (const occurrence of frame.occurrences) {
      if (occurrence.sourceResult) {
        owners.set(occurrence.sourceResult, frame.assistant);
      }
    }
  }
  return owners;
}

/** Select an owned suffix before SQLite payloads can enter JavaScript or cross a worker. */
export function selectBoundedModelRequests(
  requests: ModelContextRequest[],
  readSizes: (requests: readonly ModelContextRequest[]) => Map<ContextEntry, number>,
  limits: SessionModelContextLimits,
  prefix?: ModelContextPrefix,
): ModelContextRequest[] {
  const boundary = requests.find(
    ({ entry }) => entry.type === "compaction" || entry.type === "reset",
  );
  const candidates = requests.filter((request) => request !== boundary);
  const candidateLimit = limits.maxEvents - (boundary ? 1 : 0);
  const sizingCandidates = candidateLimit > 0 ? candidates.slice(-candidateLimit) : [];
  const sizes = readSizes(boundary ? [boundary, ...sizingCandidates] : sizingCandidates);
  let bytes = boundary ? sizes.get(boundary.entry)! : 0;
  let events = boundary ? 1 : 0;
  if (bytes > limits.maxBytes || events > limits.maxEvents) {
    throw new RangeError("Required session context boundary exceeds the model-context limit");
  }
  const replacements = new Map<
    ContextEntry,
    { request: ModelContextRequest; savedBytes: number }
  >();
  let candidateBytes = [...sizes.values()].reduce((total, size) => total + size, 0);
  // Prefer earlier requests over result bodies before choosing the bounded suffix.
  if (limits.toolResultOverflow === "omit" && candidateBytes > limits.maxBytes) {
    const omissions = sizingCandidates.flatMap((request) => {
      const { entry } = request;
      if (entry.type !== "message" || entry.message.role !== "toolResult") {
        return [];
      }
      const message = entry.message;
      return [
        {
          ...request,
          toolResultOmission:
            `Tool result body omitted from this bounded context: ${JSON.stringify(message.toolName)} ` +
            `(call ${JSON.stringify(message.toolCallId)}), original model-context event ${sizes.get(entry)!} bytes. ` +
            "The full result remains in the session transcript. Do not infer its outcome or repeat the operation from this notice.",
        },
      ];
    });
    const omittedSizes = readSizes(omissions);
    const savings = (request: ModelContextRequest) =>
      sizes.get(request.entry)! - omittedSizes.get(request.entry)!;
    for (const omission of omissions.toSorted((a, b) => savings(b) - savings(a))) {
      if (candidateBytes <= limits.maxBytes) {
        break;
      }
      const saved = savings(omission);
      if (saved > 0) {
        replacements.set(omission.entry, { request: omission, savedBytes: saved });
        sizes.set(omission.entry, omittedSizes.get(omission.entry)!);
        candidateBytes -= saved;
      }
    }
  }
  const capacity = limits.maxBytes - bytes;
  let totalBytes = candidateBytes - bytes;
  const byteLimited = totalBytes > capacity;
  let byteLimit = limits.maxBytes;
  if (byteLimited) {
    // Absolute quarter-cap cuts survive fresh readers; a fixed 75% tail would still slide.
    // Only byte pressure needs older sizing metadata. Payload acquisition stays bounded.
    for (const size of readSizes(candidates.slice(0, -sizingCandidates.length)).values()) {
      totalBytes += size;
    }
    totalBytes += prefix?.bytes ?? 0;
    const step = Math.max(1, Math.floor(capacity / 4));
    byteLimit = bytes + totalBytes - Math.ceil((totalBytes - capacity) / step) * step;
  }
  let cut = candidates.length;
  let fallbackCut = cut;
  for (const request of sizingCandidates.toReversed()) {
    const size = sizes.get(request.entry)!;
    if (bytes + size > limits.maxBytes || events + 1 > limits.maxEvents) {
      break;
    }
    bytes += size;
    events += 1;
    fallbackCut -= 1;
    if (bytes <= byteLimit) {
      cut -= 1;
    }
  }
  if (cut === 0 && !prefix?.count) {
    return requests.map((request) => replacements.get(request.entry)?.request ?? request);
  }
  const turnStarts = byteLimited
    ? candidates.flatMap(({ entry }, index) =>
        entry.type === "message" && entry.message.role === "user" ? [index] : [],
      )
    : [];
  if (byteLimited && prefix?.hasUser) {
    turnStarts.unshift(-1);
  }
  // Prefer a whole turn when one fits; otherwise keep the existing atomic-frame fallback.
  const alignToTurn = (index: number) => turnStarts.find((start) => start >= index) ?? index;
  cut = alignToTurn(cut);
  const positions = new Map<AgentMessage, number>();
  for (const [index, { entry }] of candidates.entries()) {
    if (entry.type === "message") {
      positions.set(entry.message, index);
    }
  }
  const pairing =
    prefix?.pairing ??
    readToolResultOwners(
      candidates.flatMap(({ entry }) => {
        const message =
          entry.type === "message" ? entry.message : projectSessionEntryMessage(entry);
        return message ? [message] : [];
      }),
    );
  // Map order preserves canonical assistant order, including owners in the discarded prefix.
  for (const [result, assistant] of pairing) {
    const start = assistant === PREFIX_TOOL_OWNER ? -1 : positions.get(assistant)!;
    const end = positions.get(result)!;
    if (start < cut && cut <= end) {
      cut = alignToTurn(end + 1);
    }
    if (start < fallbackCut && fallbackCut <= end) {
      fallbackCut = end + 1;
    }
  }
  // A large newest atomic frame may consume the headroom without exceeding the hard cap.
  const latestTurnStart = turnStarts.at(-1) ?? candidates.length;
  let selected = candidates.slice(
    cut === candidates.length || cut > latestTurnStart ? fallbackCut : cut,
  );
  // A discarded prefix no longer needs savings from retained tool results.
  // Recount after turn/frame closure, then restore newest affordable bodies.
  let retainedBytes = boundary ? sizes.get(boundary.entry)! : 0;
  for (const request of selected) {
    retainedBytes += sizes.get(request.entry)!;
  }
  for (const request of selected.toReversed()) {
    const replacement = replacements.get(request.entry);
    if (!replacement) {
      continue;
    }
    if (retainedBytes + replacement.savedBytes <= limits.maxBytes) {
      replacements.delete(request.entry);
      retainedBytes += replacement.savedBytes;
    }
  }
  selected = selected.map((request) => replacements.get(request.entry)?.request ?? request);
  if (selected.length === 0) {
    throw new RangeError(
      "The latest messages exceed this session's context limit. Start a new session with a brief summary to continue.",
    );
  }
  const selectedMessages = selected.flatMap(({ entry }) =>
    entry.type === "message" ? [entry.message] : [],
  );
  // Removing an older repeated ID must not turn an ambiguous result into a different call's result.
  const selectedOwners = readToolResultOwners(selectedMessages);
  for (const message of selectedMessages) {
    if (message.role === "toolResult" && pairing.get(message) !== selectedOwners.get(message)) {
      throw new RangeError("Session context limit would change tool-result ownership");
    }
  }
  return boundary ? [boundary, ...selected] : selected;
}
