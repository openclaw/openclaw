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
  it.each(["agent:main:matrix:channel:!MixedRoom:example.org", "agent:main:signal:group:AbC123="])(
    "preserves case-sensitive conversation ownership: %s",
    (currentSessionKey) => {
      const state = makeState({ currentSessionKey });
      expect(matchesSelectedTuiSession(state, { sessionKey: currentSessionKey })).toBe(true);
      expect(
        matchesSelectedTuiSession(state, { sessionKey: currentSessionKey.toLowerCase() }),
      ).toBe(false);
    },
  );
  it.each([
    ["global", "global", true],
    ["agent:main:main", undefined, false],
    ["agent:main:main", "  ", false],
    ["agent:main:main", "agent:main:other", false],
  ] as const)("matches selected %s against %s: %s", (currentSessionKey, sessionKey, matches) => {
    expect(matchesSelectedTuiSession(makeState({ currentSessionKey }), { sessionKey })).toBe(
      matches,
    );
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
