import { isAudioFileName } from "@openclaw/media-core/mime";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { TypingSignaler } from "./typing-mode.js";

export const isAudioPayload = (payload: ReplyPayload): boolean =>
  resolveSendableOutboundReplyParts(payload).mediaUrls.some(isAudioFileName);

type VerboseGateParams = {
  resolvedVerboseLevel: VerboseLevel;
  verboseLevelOverride?: VerboseLevel;
  getVerboseLevel?: () => string | undefined;
};

function createVerboseGate(
  params: VerboseGateParams,
  shouldEmit: (level: VerboseLevel) => boolean,
): () => boolean {
  return () =>
    shouldEmit(
      params.verboseLevelOverride ??
        normalizeVerboseLevel(params.getVerboseLevel?.() ?? "") ??
        params.resolvedVerboseLevel,
    );
}

export const createShouldEmitToolResult = (params: VerboseGateParams): (() => boolean) =>
  createVerboseGate(params, (level) => level !== "off");

export const createShouldEmitToolOutput = (params: VerboseGateParams): (() => boolean) =>
  createVerboseGate(params, (level) => level === "full");

export const signalTypingIfNeeded = async (
  payloads: ReplyPayload[],
  typingSignals: TypingSignaler,
): Promise<void> => {
  const shouldSignalTyping = payloads.some((payload) =>
    hasOutboundReplyContent(payload, { trimText: true }),
  );
  if (shouldSignalTyping) {
    await typingSignals.signalRunStart();
  }
};
