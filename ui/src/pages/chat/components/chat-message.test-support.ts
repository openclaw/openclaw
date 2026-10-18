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
  return typeof message === "object" &&
    message !== null &&
    typeof (message as { timestamp?: unknown }).timestamp === "number"
    ? (message as { timestamp: number }).timestamp
    : Date.now();
}

export function createAssistantMessage(content: unknown, overrides: TestMessage = {}): TestMessage {
  const timestamp = typeof overrides.timestamp === "number" ? overrides.timestamp : Date.now();
  return { role: "assistant", content, timestamp, ...overrides };
}

export function createUserMessage(content: unknown, overrides: TestMessage = {}): TestMessage {
  const timestamp = typeof overrides.timestamp === "number" ? overrides.timestamp : Date.now();
  return { role: "user", content, timestamp, ...overrides };
}

export function createToolCall(
  id: string,
  name: string,
  args: unknown,
  overrides: TestMessage = {},
) {
  return { type: "toolcall", id, name, arguments: args, ...overrides };
}

export function createToolResultBlock(
  id: string,
  name: string,
  text: string,
  overrides: TestMessage = {},
) {
  return { type: "tool_result", id, name, text, ...overrides };
}

export function createToolResultMessage(
  toolCallId: string,
  toolName: string,
  content: unknown,
  overrides: TestMessage = {},
): TestMessage {
  const timestamp = typeof overrides.timestamp === "number" ? overrides.timestamp : Date.now();
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content,
    timestamp,
    ...overrides,
  };
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

export function createMediaBlock(overrides: TestMessage) {
  return { type: "image", ...overrides };
}

export function createAssistantImageMessage(
  url: string,
  alt: string,
  imageOverrides: TestMessage = {},
  messageOverrides: TestMessage = {},
) {
  return createAssistantMessage(
    [createMediaBlock({ url, alt, ...imageOverrides })],
    messageOverrides,
  );
}

export function createAssistantAudioMessage(
  url: string,
  audioOverrides: TestMessage = {},
  messageOverrides: TestMessage = {},
) {
  return createAssistantMessage([{ type: "audio", url, ...audioOverrides }], messageOverrides);
}

export function createAttachmentBlock(
  url: string,
  kind: "audio" | "video" | "document",
  label: string,
  mimeType: string,
  attachmentOverrides: TestMessage = {},
) {
  return {
    type: "attachment",
    attachment: { url, kind, label, mimeType, ...attachmentOverrides },
  };
}

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

export function createMessageEntry(
  key: string,
  message: unknown,
): MessageGroup["messages"][number] {
  return prepareMessageGroup({ key, message }).messages[0]!;
}

export function createToolGroup(
  key: string,
  messages: TestMessageEntry[],
  overrides: TestMessageGroupOverrides = {},
): MessageGroup {
  return createMessageGroup(messages[0]?.message, "tool", { key, messages, ...overrides });
}

export function createCanvasPreview(params: {
  viewId: string;
  title?: string;
  url?: string;
  preferredHeight?: number;
}) {
  return {
    kind: "canvas",
    surface: "assistant_message",
    render: "url",
    viewId: params.viewId,
    title: params.title ?? "Inline demo",
    url: params.url ?? `/__openclaw__/canvas/documents/${params.viewId}/index.html`,
    preferredHeight: params.preferredHeight ?? 360,
  };
}

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
      presentation: {
        target: params.presentationTarget ?? "assistant_message",
      },
    }),
  };
}
