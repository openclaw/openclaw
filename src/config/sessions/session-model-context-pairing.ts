import type { AgentMessage } from "@openclaw/agent-core";
import {
  classifyToolUseResultPairing,
  extractToolCallsFromAssistant,
  extractToolResultId,
  isSyntheticMissingToolResult,
  SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";

type Assistant = Extract<AgentMessage, { role: "assistant" }>;
type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;
type Frame = ReturnType<typeof classifyToolUseResultPairing>[number];

export const PREFIX_TOOL_OWNER = Symbol("model-context-prefix-tool-owner");
type Owner = Assistant | typeof PREFIX_TOOL_OWNER;
type OwnedResult = { owner: Owner; order: number };
type CompactFrame = {
  assistant: Assistant;
  owner: Owner;
  order: number;
  results: Array<{ message: ToolResult; source: ToolResult | undefined }>;
};

export type ModelContextPairingFacts = ReadonlyMap<AgentMessage, Owner>;

type ModelContextPairing = {
  /** False means this append needs the canonical history before the cache can be reused. */
  append: (messages: readonly AgentMessage[]) => boolean;
  retain: (messages: readonly AgentMessage[]) => void;
  read: () => ModelContextPairingFacts;
};

/** Keep occurrence evidence, never old result bodies or a frame's unbounded remainder. */
function compactFrame(
  frame: Frame,
  identity: OwnedResult,
  resolveSource: (source: ToolResult) => ToolResult | undefined,
  last: boolean,
): CompactFrame {
  const occurrences = last
    ? frame.occurrences
    : frame.occurrences.filter(
        (occurrence) => !occurrence.result || isSyntheticMissingToolResult(occurrence.result),
      );
  const assistant: Assistant = {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "",
    content: occurrences.map(({ id, name }) => ({
      type: "toolCall",
      id,
      name: name ?? "",
      arguments: {},
    })),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: frame.assistant.stopReason,
    timestamp: 0,
  };
  return {
    assistant,
    ...identity,
    results: occurrences.flatMap((occurrence) => {
      if (!occurrence.result) {
        return [];
      }
      const synthetic = isSyntheticMissingToolResult(occurrence.result);
      return [
        {
          message: {
            role: "toolResult" as const,
            toolCallId: occurrence.id,
            toolName: occurrence.name ?? "",
            content: [],
            isError: synthetic,
            ...(synthetic ? { details: { [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: true } } : {}),
            timestamp: 0,
          },
          source: occurrence.sourceResult ? resolveSource(occurrence.sourceResult) : undefined,
        },
      ];
    }),
  };
}

/** Incremental canonical pairing for a bounded context; unusual displaced results can reseed. */
export function createModelContextPairing(
  messages: readonly AgentMessage[],
  retainedMessages: readonly AgentMessage[],
  limits: { maxOccurrences?: number; maxBytes?: number } = {},
): ModelContextPairing {
  const maxOccurrences = limits.maxOccurrences ?? 256;
  const maxBytes = limits.maxBytes ?? 128 * 1024;
  let frames: CompactFrame[] = [];
  let unknownPrefix = false;
  let unavailableLastFrame = false;
  let nextOrder = 0;
  const owned = new Map<ToolResult, OwnedResult>();
  let snapshot: ReturnType<ModelContextPairing["read"]> | undefined;

  function install(
    classified: Frame[],
    identities: ReadonlyMap<Assistant, OwnedResult>,
    resolveSource: (source: ToolResult) => ToolResult | undefined,
  ) {
    frames = classified.map((frame, index) => {
      const identity = identities.get(frame.assistant) ?? {
        owner: frame.assistant,
        order: nextOrder++,
      };
      for (const occurrence of frame.occurrences) {
        const source = occurrence.sourceResult && resolveSource(occurrence.sourceResult);
        if (source) {
          owned.set(source, identity);
        }
      }
      return compactFrame(frame, identity, resolveSource, index === classified.length - 1);
    });
    unavailableLastFrame = false;
    boundPrefixFrames();
    snapshot = undefined;
  }

  function boundPrefixFrames() {
    const bounded: CompactFrame[] = [];
    let count = 0;
    let bytes = 0;
    // Retained frames already fit the context window. Bound only discarded prefix evidence.
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      const frame = frames[index]!;
      const occurrences = frame.assistant.content.length;
      if (occurrences === 0) {
        continue;
      }
      if (frame.owner !== PREFIX_TOOL_OWNER) {
        bounded.push(frame);
        continue;
      }
      const frameBytes = Buffer.byteLength(
        JSON.stringify([frame.assistant, ...frame.results.map(({ message }) => message)]),
      );
      if (count + occurrences > maxOccurrences || bytes + frameBytes > maxBytes) {
        unknownPrefix ||=
          frame.results.length < occurrences ||
          frame.results.some(({ message }) => isSyntheticMissingToolResult(message));
        unavailableLastFrame ||= index === frames.length - 1;
        continue;
      }
      count += occurrences;
      bytes += frameBytes;
      bounded.push(frame);
    }
    frames = bounded.toReversed();
  }

  function retain(retained: readonly AgentMessage[]) {
    const keep = new Set(retained);
    for (const [result, identity] of owned) {
      if (!keep.has(result)) {
        owned.delete(result);
      } else if (identity.owner !== PREFIX_TOOL_OWNER && !keep.has(identity.owner)) {
        identity.owner = PREFIX_TOOL_OWNER;
      }
    }
    for (const frame of frames) {
      if (frame.owner !== PREFIX_TOOL_OWNER && !keep.has(frame.owner)) {
        frame.owner = PREFIX_TOOL_OWNER;
      }
      for (const result of frame.results) {
        if (result.source && !keep.has(result.source)) {
          result.source = undefined;
        }
      }
    }
    boundPrefixFrames();
    snapshot = undefined;
  }

  install(classifyToolUseResultPairing(messages), new Map(), (source) => source);
  retain(retainedMessages);
  return {
    retain,
    append(delta) {
      if (delta.length === 0) {
        return true;
      }
      let appendedMessages = delta;
      if (unavailableLastFrame) {
        const nextFrame = delta.findIndex(
          (message) =>
            message.role === "assistant" && extractToolCallsFromAssistant(message).length > 0,
        );
        const preceding = nextFrame < 0 ? delta : delta.slice(0, nextFrame);
        if (preceding.some((message) => message.role === "toolResult")) {
          return false;
        }
        if (nextFrame < 0) {
          return true;
        }
        appendedMessages = delta.slice(nextFrame);
      }
      const input: AgentMessage[] = [];
      const sources = new Map<ToolResult, ToolResult | undefined>();
      const identities = new Map<Assistant, OwnedResult>();
      for (const frame of frames) {
        input.push(frame.assistant);
        identities.set(frame.assistant, { owner: frame.owner, order: frame.order });
        for (const { message, source } of frame.results) {
          input.push(message);
          sources.set(message, source);
        }
      }
      const appended = new Set(appendedMessages);
      input.push(...appendedMessages);
      const classified = classifyToolUseResultPairing(input, { preserveUnframedToolResults: true });
      if (
        unknownPrefix &&
        classified.some(
          (frame) =>
            frame.remainder.some(
              (message) =>
                message.role === "toolResult" &&
                appended.has(message) &&
                extractToolResultId(message) !== null,
            ) ||
            frame.occurrences.some(
              (occurrence) =>
                occurrence.sourceResult &&
                appended.has(occurrence.sourceResult) &&
                occurrence.sourceResultIndex! >= frame.endIndex,
            ),
        )
      ) {
        return false;
      }
      for (const source of sources.values()) {
        if (source) {
          owned.delete(source);
        }
      }
      install(classified, identities, (source) =>
        sources.has(source) ? sources.get(source) : source,
      );
      return true;
    },
    read() {
      if (!snapshot) {
        const ordered = [...owned].toSorted((a, b) => a[1].order - b[1].order);
        snapshot = new Map(ordered.map(([result, { owner }]) => [result, owner]));
      }
      return snapshot;
    },
  };
}
