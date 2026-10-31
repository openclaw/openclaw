import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { prepareChatHistoryFixture } from "../../../test-helpers/chat-activity-fixtures.ts";
import { attachHistoryActivity } from "../chat-history-request.ts";
import { groupMessages } from "../chat-thread-grouping.ts";

export type TestMessage = Record<string, unknown>;
export type TestMessageEntry = Omit<MessageGroup["messages"][number], "hasVisibleContent">;
type TestMessageGroupOverrides = Omit<Partial<MessageGroup>, "messages"> & {
  messages?: TestMessageEntry[];
};

function messageTimestamp(message: unknown): number {
  const timestamp =
    typeof message === "object" && message !== null && "timestamp" in message
      ? message.timestamp
      : undefined;
  return typeof timestamp === "number" ? timestamp : Date.now();
}

const createMessage = (role: string, content: unknown, overrides: TestMessage): TestMessage => ({
  role,
  content,
  timestamp: messageTimestamp(overrides),
  ...overrides,
});

export const createAssistantMessage = (content: unknown, overrides: TestMessage = {}) =>
  createMessage("assistant", content, overrides);

export const createUserMessage = (content: unknown, overrides: TestMessage = {}) =>
  createMessage("user", content, overrides);

export const createToolCall = (
  id: string,
  name: string,
  args: unknown,
  overrides: TestMessage = {},
) => ({ type: "toolcall", id, name, arguments: args, ...overrides });

export const createToolResultBlock = (
  id: string,
  name: string,
  text: string,
  overrides: TestMessage = {},
) => ({ type: "tool_result", id, name, text, ...overrides });

export function createToolResultMessage(
  toolCallId: string,
  toolName: string,
  content: unknown,
  overrides: TestMessage = {},
): TestMessage {
  return createMessage("toolResult", content, { toolCallId, toolName, ...overrides });
}

export function prepareHistoryGroups(groups: MessageGroup[]): MessageGroup[] {
  const entries = groups.flatMap((group) => group.messages);
  const history = attachHistoryActivity(
    prepareChatHistoryFixture(
      entries.map(({ key, message }) =>
        Object.assign({}, asOptionalRecord(message), { messageId: key }),
      ),
    ),
  );
  let index = 0;
  return groups.map((group) => ({
    ...group,
    messages: group.messages.map((entry) => ({ ...entry, message: history.messages[index++]! })),
  }));
}

export const createMediaBlock = (overrides: TestMessage) => ({ type: "image", ...overrides });

export const createAssistantImageMessage = (
  url: string,
  alt: string,
  imageOverrides: TestMessage = {},
  messageOverrides: TestMessage = {},
) => createAssistantMessage([createMediaBlock({ url, alt, ...imageOverrides })], messageOverrides);

export const createAssistantAudioMessage = (
  url: string,
  audioOverrides: TestMessage = {},
  messageOverrides: TestMessage = {},
) => createAssistantMessage([{ type: "audio", url, ...audioOverrides }], messageOverrides);

export const createAttachmentBlock = (
  url: string,
  kind: "audio" | "video" | "document",
  label: string,
  mimeType: string,
  attachmentOverrides: TestMessage = {},
) => ({ type: "attachment", attachment: { url, kind, label, mimeType, ...attachmentOverrides } });

export function createMessageGroup(
  message: unknown,
  role: string,
  overrides: TestMessageGroupOverrides = {},
): MessageGroup {
  const timestamp = overrides.timestamp ?? messageTimestamp(message);
  const {
    messages: sourceMessages = [{ key: `${role}:${timestamp}:message`, message }],
    ...groupOverrides
  } = overrides;
  const groups = sourceMessages.map(prepareMessageGroup);
  const messages = groups.flatMap((group) => group.messages);
  const visibleContent = groups.some((group) => group.visibleContent === "non-text")
    ? "non-text"
    : groups.some((group) => group.visibleContent === "text")
      ? "text"
      : "none";
  return {
    kind: "group",
    key: `${role}:${timestamp}`,
    role,
    messages,
    visibleContent,
    timestamp,
    isStreaming: false,
    ...groupOverrides,
  };
}

export function prepareMessageGroup(entry: TestMessageEntry): MessageGroup {
  const [group] = groupMessages([{ kind: "message", ...entry }]);
  if (group?.kind !== "group" || !group.messages[0]) {
    throw new Error("expected a prepared message entry");
  }
  return group;
}

export const createMessageEntry = (
  key: string,
  message: unknown,
): MessageGroup["messages"][number] => prepareMessageGroup({ key, message }).messages[0]!;

export const createToolGroup = (
  key: string,
  messages: TestMessageEntry[],
  overrides: TestMessageGroupOverrides = {},
): MessageGroup =>
  createMessageGroup(messages[0]?.message, "tool", { key, messages, ...overrides });

export const createCanvasPreview = (params: {
  viewId: string;
  title?: string;
  url?: string;
  preferredHeight?: number;
}) => ({
  kind: "canvas",
  surface: "assistant_message",
  render: "url",
  viewId: params.viewId,
  title: params.title ?? "Inline demo",
  url: params.url ?? `/__openclaw__/canvas/documents/${params.viewId}/index.html`,
  preferredHeight: params.preferredHeight ?? 360,
});

export function createAssistantCanvasBlock(params: {
  suffix: string;
  title?: string;
  url?: string;
  preferredHeight?: number;
  presentationTarget?: "assistant_message" | "tool_card";
}) {
  const viewId = `cv_inline_${params.suffix}`;
  const preview = createCanvasPreview({ ...params, viewId });
  return {
    type: "canvas",
    preview,
    rawText: JSON.stringify({
      kind: "canvas",
      view: {
        backend: "canvas",
        id: viewId,
        url: preview.url,
        title: preview.title,
        preferred_height: preview.preferredHeight,
      },
      presentation: { target: params.presentationTarget ?? "assistant_message" },
    }),
  };
}
