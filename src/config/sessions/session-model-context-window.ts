import type { AgentMessage, SessionTreeEntry } from "@openclaw/agent-core";
import { projectSessionEntryMessage } from "../../../packages/agent-core/src/harness/session/session.js";
import { classifyToolUseResultPairing } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { SessionModelContextLimits } from "./session-history-read.types.js";

export type ContextEntry = SessionTreeEntry & { seq: number };
export type ModelContextRequest = {
  entry: ContextEntry;
  omitCheckpoint: boolean;
  toolResultOmission?: string;
};

/** Select an owned suffix before SQLite payloads can enter JavaScript or cross a worker. */
export function selectBoundedModelRequests(
  requests: ModelContextRequest[],
  readSizes: (requests: readonly ModelContextRequest[]) => Map<ContextEntry, number>,
  limits: SessionModelContextLimits,
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
  const capacity = limits.maxBytes - bytes;
  let totalBytes = [...sizes.values()].reduce((total, size) => total + size, 0) - bytes;
  const byteLimited = totalBytes > capacity;
  let byteLimit = limits.maxBytes;
  if (byteLimited) {
    // Absolute quarter-cap cuts survive fresh readers; a fixed 75% tail would still slide.
    // Only byte pressure needs older sizing metadata. Payload acquisition stays bounded.
    for (const size of readSizes(candidates.slice(0, -sizingCandidates.length)).values()) {
      totalBytes += size;
    }
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
  if (cut === 0) {
    return requests;
  }
  const turnStarts = byteLimited
    ? candidates.flatMap(({ entry }, index) =>
        entry.type === "message" && entry.message.role === "user" ? [index] : [],
      )
    : [];
  // Prefer a whole turn when one fits; otherwise keep the existing atomic-frame fallback.
  const alignToTurn = (index: number) => turnStarts.find((start) => start >= index) ?? index;
  cut = alignToTurn(cut);
  const messages = candidates.flatMap(({ entry }) => {
    const message = entry.type === "message" ? entry.message : projectSessionEntryMessage(entry);
    return message ? [message] : [];
  });
  const positions = new Map<AgentMessage, number>();
  for (const [index, { entry }] of candidates.entries()) {
    if (entry.type === "message") {
      positions.set(entry.message, index);
    }
  }
  const original = classifyToolUseResultPairing(messages);
  const owners = new Map<AgentMessage, AgentMessage>();
  // Occurrence ownership, including displaced results, forbids cuts through a tool frame.
  // Frames are ordered by their assistant, so advancing the cut needs only one pass.
  for (const frame of original.frames) {
    const start = positions.get(frame.assistant)!;
    for (const occurrence of frame.occurrences) {
      if (occurrence.sourceResult) {
        owners.set(occurrence.sourceResult, frame.assistant);
        const end = positions.get(occurrence.sourceResult)!;
        if (start < cut && cut <= end) {
          cut = alignToTurn(end + 1);
        }
        if (start < fallbackCut && fallbackCut <= end) {
          fallbackCut = end + 1;
        }
      }
    }
  }
  // A large newest atomic frame may consume the headroom without exceeding the hard cap.
  const latestTurnStart = turnStarts.at(-1) ?? candidates.length;
  let selected = candidates.slice(
    cut === candidates.length || cut > latestTurnStart ? fallbackCut : cut,
  );
  if (selected.length === 0 && limits.toolResultOverflow === "omit") {
    // Retain the newest historical request and close its suffix over displaced results.
    // The currently admitted user is supplied separately by native runtime callers.
    let start = candidates.findLastIndex(
      ({ entry }) => entry.type === "message" && entry.message.role === "user",
    );
    if (start < 0) {
      start = candidates.length - 1;
    }
    for (const frame of original.frames.toReversed()) {
      if (
        frame.occurrences.some(
          ({ sourceResult }) => sourceResult && positions.get(sourceResult)! >= start,
        )
      ) {
        start = Math.min(start, positions.get(frame.assistant)!);
      }
    }
    const required = candidates.slice(start);
    if (required.length + (boundary ? 1 : 0) <= limits.maxEvents) {
      const requiredSizes = readSizes(boundary ? [boundary, ...required] : required);
      let requiredBytes = [...requiredSizes.values()].reduce((total, size) => total + size, 0);
      const omissions = required.flatMap((request) => {
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
              `(call ${JSON.stringify(message.toolCallId)}), original model-context event ${requiredSizes.get(entry)!} bytes. ` +
              "The full result remains in the session transcript. Do not infer its outcome or repeat the operation from this notice.",
          },
        ];
      });
      const omittedSizes = readSizes(omissions);
      const savings = (request: ModelContextRequest) =>
        requiredSizes.get(request.entry)! - omittedSizes.get(request.entry)!;
      const replacements = new Map<ContextEntry, ModelContextRequest>();
      for (const omission of omissions.toSorted((a, b) => savings(b) - savings(a))) {
        if (requiredBytes <= limits.maxBytes) {
          break;
        }
        const saved = savings(omission);
        if (saved > 0) {
          replacements.set(omission.entry, omission);
          requiredBytes -= saved;
        }
      }
      if (requiredBytes <= limits.maxBytes) {
        selected = required.map((request) => replacements.get(request.entry) ?? request);
      }
    }
  }
  if (selected.length === 0) {
    throw new RangeError(
      "The latest messages exceed this session's context limit. Start a new session with a brief summary to continue.",
    );
  }
  const selectedMessages = selected.flatMap(({ entry }) =>
    entry.type === "message" ? [entry.message] : [],
  );
  // Removing an older repeated ID must not turn an ambiguous result into a different call's result.
  const selectedOwners = new Map<AgentMessage, AgentMessage>();
  for (const frame of classifyToolUseResultPairing(selectedMessages).frames) {
    for (const occurrence of frame.occurrences) {
      if (occurrence.sourceResult) {
        selectedOwners.set(occurrence.sourceResult, frame.assistant);
      }
    }
  }
  for (const message of selectedMessages) {
    if (message.role === "toolResult" && owners.get(message) !== selectedOwners.get(message)) {
      throw new RangeError("Session context limit would change tool-result ownership");
    }
  }
  return boundary ? [boundary, ...selected] : selected;
}
