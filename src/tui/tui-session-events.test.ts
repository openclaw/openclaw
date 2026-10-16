import { describe, expect, it } from "vitest";
import { createBaseState as makeState } from "./tui-session-actions-test-support.js";
import { matchesSelectedTuiSession, readTuiSessionUserMessage } from "./tui-session-events.js";
import type { SessionMessageEvent } from "./tui-types.js";

function readUserMessage(
  content: unknown,
  metadata: Record<string, unknown> = {},
  envelope: Omit<SessionMessageEvent, "message"> = {},
) {
  return readTuiSessionUserMessage({
    ...envelope,
    message: { role: "user", content, __openclaw: metadata },
  });
}

describe("matchesSelectedTuiSession", () => {
  it.each([
    [
      "Matrix",
      "agent:main:matrix:channel:!MixedRoom:example.org",
      "agent:main:matrix:channel:!mixedroom:example.org",
    ],
    ["Signal", "agent:main:signal:group:AbC123=", "agent:main:signal:group:abc123="],
  ])(
    "preserves case-sensitive %s conversation ownership",
    (_provider, selectedSessionKey, otherSessionKey) => {
      const state = makeState({ currentSessionKey: selectedSessionKey });

      expect(matchesSelectedTuiSession(state, { sessionKey: selectedSessionKey })).toBe(true);
      expect(matchesSelectedTuiSession(state, { sessionKey: otherSessionKey })).toBe(false);
    },
  );

  it("accepts legacy global events only for the default agent", () => {
    expect(
      matchesSelectedTuiSession(makeState({ currentSessionKey: "global" }), {
        sessionKey: "global",
      }),
    ).toBe(true);
  });

  it("rejects empty and unrelated session events", () => {
    const state = makeState();

    expect(matchesSelectedTuiSession(state, {})).toBe(false);
    expect(matchesSelectedTuiSession(state, { sessionKey: "  " })).toBe(false);
    expect(matchesSelectedTuiSession(state, { sessionKey: "agent:main:other" })).toBe(false);
  });
});

describe("readTuiSessionUserMessage", () => {
  const importedIdentity = {
    id: "provider-local-id",
    importedFrom: "claude-cli",
    externalId: "provider-local-id",
  };
  it.each([
    [
      "image block",
      [{ type: "image", source: { type: "url", url: "/image.png" } }],
      undefined,
      "Attached image",
      [{ source: "/image.png" }],
    ],
    [
      "document block",
      [
        {
          type: "attachment",
          attachment: { url: "/report.pdf", kind: "document", label: "report.pdf" },
        },
      ],
      undefined,
      "Attached file: report.pdf",
      undefined,
    ],
    [
      "canonical persisted media",
      "",
      [{ path: "/media/inbound/image.png", contentType: "image/png" }],
      "Attached image",
      [{ source: "/media/inbound/image.png" }],
    ],
  ] as const)(
    "accepts an authoritative attachment-only %s event",
    (_name, content, media, expected, images) => {
      expect(
        readUserMessage(
          content,
          {
            id: "attachment-user-1",
            idempotencyKey: "attachment-run-1:user",
            seq: 1,
            ...(media ? { media } : {}),
          },
          { sessionKey: "agent:main:main", messageId: "attachment-user-1" },
        ),
      ).toEqual({
        messageId: "attachment-user-1",
        runId: "attachment-run-1",
        sendId: "attachment-run-1",
        text: expected,
        ...(images ? { images } : {}),
      });
    },
  );

  it.each([
    [
      "prefers persisted sequence over a conflicting envelope",
      { seq: 7 },
      { messageSeq: 99 },
      { messageId: "seq:7", text: "prompt" },
    ],
    [
      "normalizes exactly one user-turn suffix",
      { id: "persisted-message", idempotencyKey: "actual:user:user" },
      { clientRunId: "another-client-run" },
      {
        messageId: "persisted-message",
        runId: "actual:user",
        sendId: "actual:user",
        text: "prompt",
      },
    ],
    [
      "uses persisted position for incomplete imported identity",
      { ...importedIdentity, seq: 7 },
      { messageId: "native-message", messageSeq: 99 },
      { messageId: "imported-seq:7", text: "prompt" },
    ],
    [
      "rejects envelope-only sequence for incomplete imported identity",
      importedIdentity,
      { messageId: "native-message", messageSeq: 7 },
      null,
    ],
  ] as const)("%s", (_name, metadata, envelope, expected) => {
    expect(readUserMessage("prompt", metadata, envelope)).toEqual(expected);
  });

  it("keys imported messages by their complete provider and CLI session identity", () => {
    const readImportedMessage = (cliSessionId: string) =>
      readUserMessage(
        "imported prompt",
        { ...importedIdentity, cliSessionId },
        { messageId: "native-or-other-provider-id" },
      );

    expect(readImportedMessage("cli-session-1")).toEqual({
      messageId: `external:${JSON.stringify(["claude-cli", "cli-session-1", "provider-local-id"])}`,
      text: "imported prompt",
    });
    expect(readImportedMessage("cli-session-2")?.messageId).not.toBe(
      readImportedMessage("cli-session-1")?.messageId,
    );
  });

  it("uses the authoritative transcript sequence when no message id is available", () => {
    expect(
      readTuiSessionUserMessage({
        messageSeq: 7,
        message: { content: "shared prompt", idempotencyKey: "run-7:user", role: "user" },
      }),
    ).toEqual({ messageId: "seq:7", runId: "run-7", sendId: "run-7", text: "shared prompt" });
  });

  it("rejects assistant and identity-free transcript messages", () => {
    expect(
      readTuiSessionUserMessage({
        messageId: "assistant-1",
        message: { content: "reply", role: "assistant" },
      }),
    ).toBeNull();
    expect(
      readTuiSessionUserMessage({ message: { content: "unidentified", role: "user" } }),
    ).toBeNull();
  });
});
