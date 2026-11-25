import { afterEach, expect, it, vi } from "vitest";
import {
  attachSessionTranscriptRunId,
  emitSessionTranscriptUpdate,
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "./transcript-events.js";

const cleanup: Array<() => void> = [];
const target = { agentId: "main", sessionId: "sess-1", sessionKey: "agent:main:main" };
const identity = { target, ...target };

function listen() {
  const publicListener = vi.fn();
  const internalListener = vi.fn();
  cleanup.push(onSessionTranscriptUpdate(publicListener));
  cleanup.push(onInternalSessionTranscriptUpdate(internalListener));
  return { publicListener, internalListener };
}

function assistant(content: unknown, stopReason: string) {
  return { role: "assistant", content, stopReason };
}

afterEach(() => {
  while (cleanup.length > 0) {
    cleanup.pop()?.();
  }
});

it.each(["assistant", "toolResult"])("persists normalized run ownership on %s rows", (role) => {
  const message = { role, content: [], __openclaw: { seq: 2 } };

  expect(attachSessionTranscriptRunId(message, "  run-owned  ")).toEqual({
    ...message,
    __openclaw: { seq: 2, runId: "run-owned" },
  });
  expect(attachSessionTranscriptRunId(message, "  ")).toBe(message);
  expect(readSessionTranscriptRunId(attachSessionTranscriptRunId(message, "  run-owned  "))).toBe(
    "run-owned",
  );
});

it("does not assign output run ownership to user rows", () => {
  const message = { role: "user", content: "prompt" };

  expect(attachSessionTranscriptRunId(message, "run-owned")).toBe(message);
});

it("does not expose file-only archive updates to public listeners", () => {
  const { publicListener, internalListener } = listen();

  emitSessionTranscriptUpdate({
    sessionFile: "  /tmp/session.jsonl  ",
    sessionKey: "  agent:main:main  ",
    agentId: "  main  ",
    sessionId: "  sess-1  ",
    message: { role: "assistant", content: "hi" },
    messageId: "  msg-1  ",
    messageSeq: 2,
    runId: "  run-1  ",
  });

  const expected = {
    ...identity,
    message: { role: "assistant", content: "hi" },
    messageId: "msg-1",
    messageSeq: 2,
    runId: "run-1",
  };
  expect(publicListener).toHaveBeenCalledWith(expected);
  expect(internalListener).toHaveBeenCalledWith({
    ...expected,
    sessionFile: "/tmp/session.jsonl",
  });
});

it("keeps normalized committed lifecycle and store ownership on internal events only", () => {
  const { publicListener, internalListener } = listen();

  emitSessionTranscriptUpdate({
    target: {
      agentId: " main ",
      sessionId: " sess-1 ",
      sessionKey: " agent:main:main ",
      storePath: "  /tmp/custom-sessions.json  ",
    },
    lifecycleRevision: "  committed-revision  ",
    messageId: "msg-1",
    assistantItemIds: ["native-item"],
  });

  expect(internalListener).toHaveBeenCalledWith({
    ...identity,
    target: { ...target, storePath: "/tmp/custom-sessions.json" },
    lifecycleRevision: "committed-revision",
    messageId: "msg-1",
    assistantItemIds: ["native-item"],
  });
  expect(publicListener).toHaveBeenCalledWith({
    ...identity,
    messageId: "msg-1",
  });
});

it("omits provider replay only from the shallow public message projection", () => {
  const { publicListener, internalListener } = listen();
  const content = [{ type: "text", text: "visible" }];
  const metadata = { nested: true };
  const providerReplay = { type: "opaque", data: "private" };
  const message = { role: "assistant", content, metadata, providerReplay };
  emitSessionTranscriptUpdate({ target, message, messageId: "msg-1" });

  const publicUpdate = publicListener.mock.calls[0]?.[0];
  const internalUpdate = internalListener.mock.calls[0]?.[0];
  expect(publicUpdate?.message).toEqual({ role: "assistant", content, metadata });
  expect(publicUpdate?.message).not.toBe(message);
  expect(publicUpdate?.message.content).toBe(content);
  expect(publicUpdate?.message.metadata).toBe(metadata);
  expect(internalUpdate?.message).toBe(message);
  expect(internalUpdate?.message.providerReplay).toBe(providerReplay);
  expect(message.providerReplay).toBe(providerReplay);
});

it("derives public target identity from legacy-shaped internal updates", () => {
  const listener = vi.fn();
  cleanup.push(onSessionTranscriptUpdate(listener));

  emitSessionTranscriptUpdate({
    sessionFile: "/tmp/session.jsonl",
    sessionKey: "agent:main:main",
    sessionId: "sess-1",
  });

  expect(listener).toHaveBeenCalledWith(identity);
});

it("drops public global file updates without target identity", () => {
  const { publicListener, internalListener } = listen();

  emitSessionTranscriptUpdate({
    sessionFile: "/tmp/session.jsonl",
    sessionKey: "global",
  });

  expect(publicListener).not.toHaveBeenCalled();
  expect(internalListener).toHaveBeenCalledWith({
    sessionFile: "/tmp/session.jsonl",
    sessionKey: "global",
  });
});

it("drops invalid message sequence values on internal file updates", () => {
  const listener = vi.fn();
  cleanup.push(onInternalSessionTranscriptUpdate(listener));

  const sessionFile = "/tmp/session.jsonl";
  for (const messageSeq of [0, 1.5, Number.POSITIVE_INFINITY]) {
    emitSessionTranscriptUpdate({ sessionFile, messageSeq, lifecycleRevision: "  " });
  }
  expect(listener.mock.calls).toEqual([[{ sessionFile }], [{ sessionFile }], [{ sessionFile }]]);
});

it.each([
  { name: "user", message: { role: "user" }, expected: undefined },
  { name: "tool result", message: { role: "toolResult" }, expected: undefined },
  {
    name: "intermediate tool turn without a call block",
    message: assistant([], "toolUse"),
    expected: undefined,
  },
  ...["toolCall", "toolUse", "functionCall"].map((type) => ({
    name: `incomplete ${type} block`,
    message: assistant([{ type }], "error"),
    expected: undefined,
  })),
  ...["stop", "aborted"].map((stopReason) => ({
    name: `${stopReason} terminal assistant`,
    message: assistant([{ type: "text", text: "answer" }], stopReason),
    expected: "run-owned",
  })),
])("attributes run ownership only to terminal assistants: $name", ({ message, expected }) => {
  expect(resolveTerminalAssistantTranscriptRunId(message, "  run-owned  ")).toBe(expected);
  expect(resolveTerminalAssistantTranscriptRunId(message, "  ")).toBeUndefined();
});
