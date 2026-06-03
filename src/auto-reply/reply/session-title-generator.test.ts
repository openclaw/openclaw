import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateConversationLabel = vi.hoisted(() => vi.fn());
const resolveSessionTranscriptCandidates = vi.hoisted(() => vi.fn());
const updateSessionStoreEntry = vi.hoisted(() => vi.fn());

vi.mock("../../config/sessions.js", async () => {
  const original = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...original,
    updateSessionStoreEntry,
  };
});

vi.mock("../../gateway/session-transcript-files.fs.js", () => ({
  resolveSessionTranscriptCandidates,
}));

vi.mock("./conversation-label-generator.js", () => ({
  generateConversationLabel,
}));

import type { SessionEntry } from "../../config/sessions.js";
import { maybeGenerateSessionTitle } from "./session-title-generator.js";

let tempDir: string | undefined;

function createTranscript(messages: string[]): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-title-"));
  const transcriptPath = path.join(tempDir, "session.jsonl");
  fs.writeFileSync(
    transcriptPath,
    messages
      .map((message) =>
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: message }],
          },
        }),
      )
      .join("\n"),
  );
  return transcriptPath;
}

describe("maybeGenerateSessionTitle", () => {
  beforeEach(() => {
    generateConversationLabel.mockReset();
    resolveSessionTranscriptCandidates.mockReset();
    updateSessionStoreEntry.mockReset();
    generateConversationLabel.mockResolvedValue("Generated Title");
    updateSessionStoreEntry.mockImplementation(async (params: { update: () => unknown }) => {
      await params.update();
    });
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("does not generate titles unless sessionTitle is explicitly enabled", async () => {
    maybeGenerateSessionTitle({
      cfg: {},
      sessionKey: "agent:main:abc",
      sessionEntry: { sessionId: "abc" } as SessionEntry,
      storePath: "/tmp/store.json",
    });

    await Promise.resolve();

    expect(generateConversationLabel).not.toHaveBeenCalled();
    expect(updateSessionStoreEntry).not.toHaveBeenCalled();
  });

  it("passes the runtime session model and auth profile to title generation", async () => {
    const transcriptPath = createTranscript(["first", "second", "third"]);
    resolveSessionTranscriptCandidates.mockReturnValue([transcriptPath]);

    maybeGenerateSessionTitle({
      cfg: { sessionTitle: { enabled: true, turnsBeforeTitle: 3 } },
      sessionKey: "agent:main:abc",
      sessionEntry: {
        sessionId: "abc",
        modelProvider: "openai",
        model: "gpt-runtime",
      } as SessionEntry,
      storePath: "/tmp/store.json",
      agentId: "main",
      agentDir: "/tmp/agent",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
    });

    await vi.waitFor(() => expect(generateConversationLabel).toHaveBeenCalledOnce());

    expect(generateConversationLabel).toHaveBeenCalledWith({
      userMessage: "first\n---\nsecond\n---\nthird",
      prompt:
        "Generate a concise, descriptive title (max 50 chars) for a conversation based on the user's messages below. Use the same language as the user's messages. Return ONLY the title, nothing else. No quotes, no prefixes.",
      cfg: { sessionTitle: { enabled: true, turnsBeforeTitle: 3 } },
      agentId: "main",
      agentDir: "/tmp/agent",
      maxLength: 50,
      modelProvider: "openai",
      modelId: "gpt-runtime",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
    });
    expect(updateSessionStoreEntry).toHaveBeenCalledOnce();
  });

  it.each([
    ["manual display name", { displayName: "Manual project" }],
    ["channel subject", { subject: "Channel topic" }],
  ])("does not generate titles for sessions with %s", async (_label, titleFields) => {
    const transcriptPath = createTranscript(["first", "second", "third"]);
    resolveSessionTranscriptCandidates.mockReturnValue([transcriptPath]);

    maybeGenerateSessionTitle({
      cfg: { sessionTitle: { enabled: true, turnsBeforeTitle: 3 } },
      sessionKey: "agent:main:abc",
      sessionEntry: { sessionId: "abc", ...titleFields } as SessionEntry,
      storePath: "/tmp/store.json",
    });

    await Promise.resolve();

    expect(resolveSessionTranscriptCandidates).not.toHaveBeenCalled();
    expect(generateConversationLabel).not.toHaveBeenCalled();
    expect(updateSessionStoreEntry).not.toHaveBeenCalled();
  });

  it("caps title-model transcript excerpts after counting a long first JSONL record", async () => {
    const longFirstMessage = "a".repeat(9000);
    const transcriptPath = createTranscript([longFirstMessage, "second", "third"]);
    resolveSessionTranscriptCandidates.mockReturnValue([transcriptPath]);

    maybeGenerateSessionTitle({
      cfg: { sessionTitle: { enabled: true, turnsBeforeTitle: 3 } },
      sessionKey: "agent:main:abc",
      sessionEntry: { sessionId: "abc" } as SessionEntry,
      storePath: "/tmp/store.json",
    });

    await vi.waitFor(() => expect(generateConversationLabel).toHaveBeenCalledOnce());

    expect(generateConversationLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: `${"a".repeat(1000)}\n---\nsecond\n---\nthird`,
      }),
    );
    expect(updateSessionStoreEntry).toHaveBeenCalledOnce();
  });

  it("enforces a total title-model input cap", async () => {
    const transcriptPath = createTranscript(Array.from({ length: 5 }, () => "x".repeat(9000)));
    resolveSessionTranscriptCandidates.mockReturnValue([transcriptPath]);

    maybeGenerateSessionTitle({
      cfg: { sessionTitle: { enabled: true, turnsBeforeTitle: 5 } },
      sessionKey: "agent:main:abc",
      sessionEntry: { sessionId: "abc" } as SessionEntry,
      storePath: "/tmp/store.json",
    });

    await vi.waitFor(() => expect(generateConversationLabel).toHaveBeenCalledOnce());

    const titleRequest = generateConversationLabel.mock.calls[0]?.[0] as { userMessage: string };
    expect(titleRequest.userMessage).toHaveLength(4000);
    expect(updateSessionStoreEntry).toHaveBeenCalledOnce();
  });
});
