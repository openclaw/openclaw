import { expect } from "vitest";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import { buildChatItems } from "../chat-thread-build.ts";
import type { BuildChatItemsProps } from "../chat-thread-contract.ts";
import { makeMessage } from "../chat-thread.test-support.ts";
import { projectTranscriptChain, projectTranscriptIndex } from "./chat-transcript-message-index.ts";

export const sessionKey = "agent:main:dashboard:0f6d5a1c-5a9e-4c1e-9b1a-2f3c4d5e6f70";

export const finalAnswer = (id: string, seq: number, fields = {}) =>
  makeMessage(id, seq, { phase: "final_answer", stopReason: "stop", ...fields });
export function makeTool(
  id: string,
  seq: number,
  runId: string | undefined,
  timestamp: number,
  turnBoundary?: boolean,
) {
  return {
    ...makeMessage(id, seq, { role: "toolResult", content: "Evidence", timestamp, runId }),
    toolName: "read",
    toolCallId: id,
    __openclaw: { id, seq, runId, turnBoundary },
  };
}
export const partial = makeMessage("partial", 2);
export const history = [makeMessage("question", 1, { role: "user" }), partial];

export function chatProps(overrides: Partial<BuildChatItemsProps> = {}): BuildChatItemsProps {
  return {
    paneId: "message-index",
    sessionKey,
    messages: history,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  };
}
export const chatItems = (overrides: Partial<BuildChatItemsProps> = {}) =>
  buildChatItems(chatProps(overrides));

export const chainOptions = { sessionKey, runWorking: false, searchActive: false };
export const labels = { assistantName: "Assistant", userId: "reader", userName: "Reader" };
export type Chain = ReturnType<typeof projectTranscriptChain>;
export type Index = ReturnType<typeof projectTranscriptIndex>;
type ChainOptions = Partial<Parameters<typeof projectTranscriptChain>[1]>;
type RenderItem = Chain["transcriptItems"][number];
export function chainFor(
  items: Parameters<typeof projectTranscriptChain>[0],
  options: ChainOptions = {},
) {
  return projectTranscriptChain(items, { ...chainOptions, ...options });
}
export function indexFor(chain: Chain, expanded = new Map<string, boolean>(), props = labels) {
  return projectTranscriptIndex(chain, expanded, props);
}
export function projectHistory(
  messages: unknown[],
  options: Partial<BuildChatItemsProps> & ChainOptions = {},
) {
  return chainFor(chatItems({ messages, ...options }), options);
}
export const framesOf = (chain: Chain) => kind(chain.transcriptItems, "agent-run-frame");
export function onlyFrame(chain: Chain) {
  const frames = framesOf(chain);
  expect(frames).toHaveLength(1);
  return frames[0]!;
}
export const transcriptParts = (chain: Chain) =>
  chain.transcriptItems.flatMap((item) => (item.kind === "agent-run-frame" ? item.parts : [item]));
export const kind = <K extends RenderItem["kind"]>(items: readonly RenderItem[], type: K) =>
  items.filter((item): item is Extract<RenderItem, { kind: K }> => item.kind === type);
export const messagesIn = (items: readonly Parameters<typeof chatItemGroups>[0][]) =>
  items.flatMap(chatItemGroups).flatMap((group) => group.messages.map(({ message }) => message));
export const frameShows = (frame: RenderItem | undefined, message: unknown) =>
  frame?.kind === "agent-run-frame" && messagesIn(kind(frame.parts, "group")).includes(message);
export const completedOutcome = (message: unknown) => ({
  kind: "completed",
  actionOwner: { message },
});
export const replyFrameShape = (outcome: unknown, ...parts: unknown[]) => ({
  kind: "agent-run-frame",
  runId: "run-1",
  boundaryId: "send:run-1",
  outcome,
  parts,
});
