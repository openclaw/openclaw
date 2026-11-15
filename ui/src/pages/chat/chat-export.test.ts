import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { downloadTextFile } from "../../lib/download.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { exportCurrentChat } from "./chat-export.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { makeChatHost } from "./chat-host.test-support.ts";

vi.mock("../../lib/download.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/download.ts")>()),
  downloadTextFile: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());

function fixture(
  response: (params: { offset: number; limit: number }) => Promise<ChatHistoryResult>,
) {
  return Object.assign(
    makeChatHost({
      hello: gatewayHelloForMethods(["chat.history"]),
      requestHandlers: { "chat.history": response },
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
