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
  return {
    publicListener,
    internalListener,
    expectUpdates(publicUpdate: unknown, internalUpdate: unknown) {
      expect(publicListener.mock.calls).toEqual([[publicUpdate]]);
      expect(internalListener.mock.calls).toEqual([[internalUpdate]]);
    },
  };
}

function assistant(content: unknown, stopReason: string) {
  return { role: "assistant", content, stopReason };
}

afterEach(() => {
  while (cleanup.length > 0) {
    cleanup.pop()?.();
  }
});

it.each(["assistant", "toolResult", "user"])(
  "normalizes output run ownership on %s rows",
  (role) => {
    const message = { role, content: [], __openclaw: { seq: 2 } };
    const attached = attachSessionTranscriptRunId(message, "  run-owned  ");
    if (role === "user") {
      expect(attached).toBe(message);
    } else {
      expect(attached).toEqual({ ...message, __openclaw: { seq: 2, runId: "run-owned" } });
      expect(readSessionTranscriptRunId(attached)).toBe("run-owned");
    }
    expect(attachSessionTranscriptRunId(message, "  ")).toBe(message);
  },
);

it("does not expose file-only archive updates to public listeners", () => {
  const { expectUpdates } = listen();
  const message = { role: "assistant", content: "hi" };

  emitSessionTranscriptUpdate({
    sessionFile: "  /tmp/session.jsonl  ",
    sessionKey: "  agent:main:main  ",
    agentId: "  main  ",
    sessionId: "  sess-1  ",
    message,
    messageId: "  msg-1  ",
    messageSeq: 2,
    runId: "  run-1  ",
  });

  const expected = {
    ...identity,
    message,
    messageId: "msg-1",
    messageSeq: 2,
    runId: "run-1",
  };
  expectUpdates(expected, { ...expected, sessionFile: "/tmp/session.jsonl" });
});

it("keeps normalized committed lifecycle and store ownership on internal events only", () => {
  const { expectUpdates } = listen();

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

  expectUpdates(
    { ...identity, messageId: "msg-1" },
    {
      ...identity,
      target: { ...target, storePath: "/tmp/custom-sessions.json" },
      lifecycleRevision: "committed-revision",
      messageId: "msg-1",
      assistantItemIds: ["native-item"],
    },
  );
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

it.each([
  ["legacy identity", { sessionKey: target.sessionKey, sessionId: target.sessionId }, [[identity]]],
  ["global file without identity", { sessionKey: "global" }, []],
] as const)("projects %s updates", (_name, update, publicCalls) => {
  const { publicListener, internalListener } = listen();
  const sessionFile = "/tmp/session.jsonl";
  emitSessionTranscriptUpdate({ sessionFile, ...update });
  expect(publicListener.mock.calls).toEqual(publicCalls);
  expect(internalListener).toHaveBeenCalledWith(
    _name === "legacy identity" ? { sessionFile, ...identity } : { sessionFile, ...update },
  );
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
  ["user", { role: "user" }, undefined],
  ["tool result", { role: "toolResult" }, undefined],
  ["intermediate tool turn", assistant([], "toolUse"), undefined],
  ...["toolCall", "toolUse", "functionCall"].map(
    (type) => [type, assistant([{ type }], "error"), undefined] as const,
  ),
  ...["stop", "aborted"].map(
    (stopReason) =>
      [stopReason, assistant([{ type: "text", text: "answer" }], stopReason), "run-owned"] as const,
  ),
])("attributes run ownership only to terminal assistants: %s", (_name, message, expected) => {
  expect(resolveTerminalAssistantTranscriptRunId(message, "  run-owned  ")).toBe(expected);
  expect(resolveTerminalAssistantTranscriptRunId(message, "  ")).toBeUndefined();
});
