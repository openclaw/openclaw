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
    const tmpFile = path.join(os.tmpdir(), `clawdbot-audio-${Date.now()}.ogg`);
    await fs.writeFile(tmpFile, tmpBuf);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => tmpBuf,
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

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
    const { transcribeInboundAudio } = await import("./transcription.js");
    const result = await transcribeInboundAudio(
      cfg as never,
      ctx as never,
      runtime as never,
    );
    expect(result?.text).toBe("transcribed text");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns undefined when no transcription command", async () => {
    const { transcribeInboundAudio } = await import("./transcription.js");
    const res = await transcribeInboundAudio(
      { audio: {} } as never,
      {} as never,
      runtime as never,
    );
    expect(res).toBeUndefined();
  });
});
