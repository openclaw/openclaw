import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../globals.js", () => ({
  isVerbose: () => false,
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
}));

vi.mock("../process/exec.js", () => ({
  runExec: vi.fn(),
}));

vi.mock("../media/fetch.js", () => ({
  fetchRemoteMedia: vi.fn(),
}));

const runtime = {
  error: vi.fn(),
};

describe("transcribeInboundAudio", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("downloads mediaUrl to temp file and returns transcript", async () => {
    const tmpBuf = Buffer.from("audio-bytes");

    const cfg = {
      tools: {
        audio: {
          transcription: {
            args: ["echo", "{{MediaPath}}"],
            timeoutSeconds: 5,
          },
        },
      },
    };
    const ctx = { MediaUrl: "https://example.com/audio.ogg" };

    const execModule = await import("../process/exec.js");
    vi.mocked(execModule.runExec).mockResolvedValue({
      stdout: "transcribed text\n",
      stderr: "",
    });
    const fetchModule = await import("../media/fetch.js");
    vi.mocked(fetchModule.fetchRemoteMedia).mockResolvedValue({
      buffer: tmpBuf,
    });
    const { transcribeInboundAudio } = await import("./transcription.js");
    const result = await transcribeInboundAudio(cfg as never, ctx as never, runtime as never);
    expect(result?.text).toBe("transcribed text");
    expect(fetchModule.fetchRemoteMedia).toHaveBeenCalled();
  });

  it("returns undefined when no transcription command", async () => {
    const { transcribeInboundAudio } = await import("./transcription.js");
    const res = await transcribeInboundAudio({ audio: {} } as never, {} as never, runtime as never);
    expect(res).toBeUndefined();
  });

  it("skips local files that exceed maxBytes", async () => {
    const tmpFile = path.join(os.tmpdir(), `clawdbot-audio-${Date.now()}.ogg`);
    await fs.writeFile(tmpFile, Buffer.alloc(5));

    const cfg = {
      tools: {
        audio: {
          transcription: {
            args: ["echo", "{{MediaPath}}"],
            maxBytes: 2,
          },
        },
      },
    };
    const ctx = { MediaPath: tmpFile };

    const execModule = await import("../process/exec.js");
    runtime.error.mockClear();
    const { transcribeInboundAudio } = await import("./transcription.js");
    const res = await transcribeInboundAudio(cfg as never, ctx as never, runtime as never);
    expect(res).toBeUndefined();
    expect(execModule.runExec).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("skips remote media that exceeds maxBytes without erroring", async () => {
    const cfg = {
      tools: {
        audio: {
          transcription: {
            args: ["echo", "{{MediaPath}}"],
            maxBytes: 2,
          },
        },
      },
    };
    const ctx = { MediaUrl: "https://example.com/audio.ogg" };

    const fetchModule = await import("../media/fetch.js");
    vi.mocked(fetchModule.fetchRemoteMedia).mockRejectedValue(
      new Error("Failed to fetch media from https://example.com/audio.ogg: payload exceeds maxBytes 2"),
    );
    const execModule = await import("../process/exec.js");
    runtime.error.mockClear();
    const { transcribeInboundAudio } = await import("./transcription.js");
    const res = await transcribeInboundAudio(cfg as never, ctx as never, runtime as never);
    expect(res).toBeUndefined();
    expect(execModule.runExec).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });
});
