import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { downloadTextFile } from "../../lib/download.ts";
import { copySessionMarkdown } from "../../lib/sessions/session-menu-markdown.runtime.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createSessionContext } from "./chat-application-context.test-support.ts";
import { exportCurrentChat } from "./chat-export.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { makeChatHost } from "./chat-host.test-support.ts";

vi.mock("../../lib/clipboard.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/clipboard.ts")>()),
  copyToClipboard: vi.fn(async () => true),
}));
vi.mock("../../lib/download.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/download.ts")>()),
  downloadTextFile: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());

function fixture(
  response: (params: { offset: number; limit: number }) => Promise<ChatHistoryResult>,
  getFull?: () => unknown,
) {
  return Object.assign(
    makeChatHost({
      sessionKey: "agent:main:export",
      hello: gatewayHelloForMethods(["chat.history", "chat.message.get"]),
      requestHandlers: { "chat.history": response, "chat.message.get": getFull },
    }),
    {
      assistantName: "OpenClaw",
      currentSessionId: "export-session",
    },
  );
}
const message = (seq: number) => ({
  role: "assistant",
  content: `Message ${seq}`,
  __openclaw: { seq },
});
const page = (messages: unknown[], extra: Partial<ChatHistoryResult> = {}): ChatHistoryResult => ({
  messages,
  sessionId: "export-session",
  totalMessages: 3,
  hasMore: false,
  deltaCursor: "stable",
  ...extra,
});

it("downloads every page chronologically without modifying rendered history", async () => {
  const host = fixture(async ({ offset }) =>
    offset === 1
      ? page([message(1), message(2)])
      : page([message(3)], { hasMore: true, nextOffset: 1 }),
  );
  const rendered = host.chatMessages;
  await expect(exportCurrentChat(host, () => true)).resolves.toBe("downloaded");
  expect(downloadTextFile).toHaveBeenCalledWith(
    expect.stringMatching(/\.md$/),
    expect.stringMatching(/Message 1[\s\S]*Message 2[\s\S]*Message 3/),
    "text/markdown",
  );
  expect(host.chatMessages).toBe(rendered);
});

it("does not download partial history when an older page fails", async () => {
  const host = fixture(async ({ offset }) => {
    if (offset) {
      throw new Error("History unavailable");
    }
    return page([message(3)], { hasMore: true, nextOffset: 1 });
  });
  await expect(exportCurrentChat(host, () => true)).rejects.toThrow("History unavailable");
  expect(downloadTextFile).not.toHaveBeenCalled();
});

it.each(["session", "connection", "instance", "presentation"] as const)(
  "does not download after its %s changes",
  async (change) => {
    const pending = createDeferred<ChatHistoryResult>();
    const host = fixture(() => pending.promise);
    let presented = true;
    const exporting = exportCurrentChat(host, () => presented);
    const invalidate = {
      session: () => (host.sessionKey = "agent:main:other"),
      connection: () => host.connectionEpoch++,
      instance: () => (host.currentSessionId = "replacement"),
      presentation: () => (presented = false),
    };
    invalidate[change]();
    pending.resolve(page([message(3)]));
    await expect(exporting).rejects.toThrow();
    expect(downloadTextFile).not.toHaveBeenCalled();
  },
);

const oversized = {
  role: "assistant",
  content: [{ type: "text", text: "[chat.history omitted: message too large]" }],
  __openclaw: { id: "large", seq: 2, truncated: true, reason: "oversized" },
};

function copyMarkdown(host: ReturnType<typeof fixture>) {
  const context = createSessionContext(host.client!);
  context.publishGatewaySnapshot({ ...context.gateway.snapshot, hello: host.hello });
  return copySessionMarkdown({
    context,
    session: { key: host.sessionKey, sessionId: host.currentSessionId },
    isCurrent: () => true,
  });
}

it.each([131_072, 131_073])(
  "exports the complete %i-byte row once across overlapping pages",
  async (bytes) => {
    const full = { role: "assistant", content: "", __openclaw: { id: "large", seq: 2 } };
    full.content = "x".repeat(bytes - new TextEncoder().encode(JSON.stringify(full)).length);
    const wire = bytes === 131_072 ? full : oversized;
    const getFull = vi.fn(() => ({ ok: true, message: full }));
    const host = fixture(
      async ({ offset }) =>
        offset
          ? page([message(1), full])
          : page([wire, message(3)], { hasMore: true, nextOffset: 1 }),
      getFull,
    );
    const markdown = `# Chat with OpenClaw\n\n## OpenClaw\n\nMessage 1\n\n## OpenClaw\n\n${full.content}\n\n## OpenClaw\n\nMessage 3\n`;

    await expect(exportCurrentChat(host, () => true)).resolves.toBe("downloaded");
    await expect(copyMarkdown(host)).resolves.toBe(true);
    expect(downloadTextFile).toHaveBeenCalledWith(expect.any(String), markdown, "text/markdown");
    expect(copyToClipboard).toHaveBeenCalledWith(markdown, expect.any(Function));
    if (bytes === 131_072) {
      expect(getFull).not.toHaveBeenCalled();
    } else {
      expect(getFull).toHaveBeenCalledTimes(2);
      expect(getFull).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: host.sessionKey,
          sessionId: host.currentSessionId,
          messageId: "large",
        }),
      );
    }
  },
);

it.each([
  { role: "toolResult", toolCallId: "large-call", toolName: "read" },
  { role: "assistant", toolCallId: "large-call" },
  { role: "system" },
])("exports the surrounding turns without recovering an omitted $role row", async (envelope) => {
  const getFull = vi.fn(() => ({ ok: false, unavailableReason: "oversized" }));
  const user = { role: "user", senderLabel: "You", content: "Read it." };
  const host = fixture(
    async () => page([user, { ...oversized, ...envelope }, message(3)]),
    getFull,
  );
  const markdown = "# Chat with OpenClaw\n\n## You\n\nRead it.\n\n## OpenClaw\n\nMessage 3\n";

  await expect(exportCurrentChat(host, () => true)).resolves.toBe("downloaded");
  await expect(copyMarkdown(host)).resolves.toBe(true);
  expect(downloadTextFile).toHaveBeenCalledWith(expect.any(String), markdown, "text/markdown");
  expect(copyToClipboard).toHaveBeenCalledWith(markdown, expect.any(Function));
  expect(getFull).not.toHaveBeenCalled();
});

it.each(["quota", "connection"] as const)(
  "publishes no partial Markdown on a %s failure",
  async (fault) => {
    const host = fixture(
      async () => page([message(1), oversized]),
      () => {
        if (fault === "connection") {
          throw new Error("Connection closed");
        }
        return { ok: false, unavailableReason: "oversized" };
      },
    );
    await expect(exportCurrentChat(host, () => true)).rejects.toThrow();
    await expect(copyMarkdown(host)).rejects.toThrow();
    expect(downloadTextFile).not.toHaveBeenCalled();
    expect(copyToClipboard).not.toHaveBeenCalled();
  },
);

it.each(["sibling", "collapsed group"] as const)(
  "rejects a by-ID row that cannot identify a capped display fragment (%s)",
  async (shape) => {
    const final = {
      type: "text",
      text: "Answer",
      textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
    };
    const full = {
      role: "assistant",
      __openclaw: { id: "large", seq: 2 },
      content: [{ type: "text", text: "Progress" }, final],
    };
    const rows = shape === "sibling" ? [oversized, { ...full, content: [final] }] : [oversized];
    const host = fixture(
      async () => page(rows),
      () => ({ ok: true, message: full }),
    );
    await expect(exportCurrentChat(host, () => true)).rejects.toThrow();
    expect(downloadTextFile).not.toHaveBeenCalled();
  },
);
