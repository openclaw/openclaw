import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionTranscriptPathInDir } from "./paths.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { appendSessionTranscriptMessage } from "./transcript-append.js";

describe("appendSessionTranscriptMessage — redaction", () => {
  const fixture = useTempSessionsFixture("transcript-redact-test-");

  function readMessages(sessionFile: string) {
    return fs
      .readFileSync(sessionFile, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; message?: unknown })
      .filter((r) => r.type === "message")
      .map((r) => r.message);
  }

  it("masks secrets in message content before writing to disk", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir("redact-on", fixture.sessionsDir());
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "user",
        content: [{ type: "text", text: "my key is sk-abcdef1234567890xyz ok" }],
      },
      config,
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).toContain("ok"); // safe text preserved

    const [msg] = readMessages(sessionFile) as Array<{
      content: Array<{ text: string }>;
    }>;
    expect(msg.content[0].text).not.toContain("sk-abcdef1234567890xyz");
  });

  it("writes content unchanged when redactSensitive is off", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir("redact-off", fixture.sessionsDir());
    const config: OpenClawConfig = { logging: { redactSensitive: "off" } };

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "user",
        content: [{ type: "text", text: "my key is sk-abcdef1234567890xyz" }],
      },
      config,
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).toContain("sk-abcdef1234567890xyz");
  });

  it("masks secrets when config is undefined (default patterns)", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir("redact-undef", fixture.sessionsDir());

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "user",
        content: [{ type: "text", text: "my key is sk-abcdef1234567890xyz" }],
      },
      // config intentionally omitted
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
  });
});
