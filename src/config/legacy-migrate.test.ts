import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-migrate.js";

describe("legacy migrate audio transcription", () => {
  it("moves routing.transcribeAudio into tools.media.audio.models", () => {
    const res = migrateLegacyConfig({
      routing: {
        transcribeAudio: {
          command: ["whisper", "--model", "base"],
          timeoutSeconds: 2,
        },
      },
    });

    expect(res.changes).toContain("Moved routing.transcribeAudio → tools.media.audio.models.");
    expect(res.config?.tools?.media?.audio).toEqual({
      enabled: true,
      models: [
        {
          command: "whisper",
          type: "cli",
          args: ["--model", "base"],
          timeoutSeconds: 2,
        },
      ],
    });
    expect((res.config as { routing?: unknown } | null)?.routing).toBeUndefined();
  });

  it("keeps existing tools media model and drops legacy routing value", () => {
    const res = migrateLegacyConfig({
      routing: {
        transcribeAudio: {
          command: ["whisper", "--model", "tiny"],
        },
      },
      tools: {
        media: {
          audio: {
            models: [{ command: "existing", type: "cli" }],
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Removed routing.transcribeAudio (tools.media.audio.models already set).",
    );
    expect(res.config?.tools?.media?.audio?.models).toEqual([{ command: "existing", type: "cli" }]);
    expect((res.config as { routing?: unknown } | null)?.routing).toBeUndefined();
  });

  it("drops invalid audio.transcription payloads", () => {
    const res = migrateLegacyConfig({
      audio: {
        transcription: {
          command: [{}],
        },
      },
    });

    expect(res.changes).toContain("Removed audio.transcription (invalid or empty command).");
    expect(res.config?.audio).toBeUndefined();
    expect(res.config?.tools?.media?.audio).toBeUndefined();
  });
});

describe("legacy migrate mention routing", () => {
  it("moves routing.groupChat.requireMention into channel group defaults", () => {
    const res = migrateLegacyConfig({
      routing: {
        groupChat: {
          requireMention: true,
        },
      },
    });

    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → channels.telegram.groups."*".requireMention.',
    );
    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → channels.imessage.groups."*".requireMention.',
    );
    expect(res.config?.channels?.telegram?.groups?.["*"]?.requireMention).toBe(true);
    expect(res.config?.channels?.imessage?.groups?.["*"]?.requireMention).toBe(true);
    expect((res.config as { routing?: unknown } | null)?.routing).toBeUndefined();
  });

  it("moves channels.telegram.requireMention into groups.*.requireMention", () => {
    const res = migrateLegacyConfig({
      channels: {
        telegram: {
          requireMention: false,
        },
      },
    });

    expect(res.changes).toContain(
      'Moved telegram.requireMention → channels.telegram.groups."*".requireMention.',
    );
    expect(res.config?.channels?.telegram?.groups?.["*"]?.requireMention).toBe(false);
    expect(
      (res.config?.channels?.telegram as { requireMention?: unknown } | undefined)?.requireMention,
    ).toBeUndefined();
  });
});
