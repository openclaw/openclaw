import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  runCommandWithTimeout: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: mocks.existsSync,
  };
});

const { cliTTS } = await import("./tts-core.js");

describe("cliTTS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders template variables correctly", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    mocks.existsSync.mockReturnValue(true);

    const config = {
      command: "say",
      args: ["-o", "{{TtsOutputPath}}", "{{TtsText}}", "-f", "{{TtsOutputFormat}}"],
    };

    await cliTTS({
      text: "Hello world",
      outputPath: "/tmp/test.mp3",
      config,
      outputFormat: "mp3",
      timeoutMs: 30000,
    });

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(
      ["say", "-o", "/tmp/test.mp3", "Hello world", "-f", "mp3"],
      expect.objectContaining({ timeoutMs: 30000 }),
    );
  });

  it("preserves unrecognized template variables", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    mocks.existsSync.mockReturnValue(true);

    const config = {
      command: "custom-tool",
      args: ["--text", "{{TtsText}}", "--custom", "{{UnknownVar}}", "--typo", "{{TtsOutPutPath}}"],
    };

    await cliTTS({
      text: "Hello",
      outputPath: "/tmp/out.mp3",
      config,
      outputFormat: "mp3",
      timeoutMs: 30000,
    });

    // Unknown vars should be preserved, not collapsed to empty strings
    expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(
      [
        "custom-tool",
        "--text",
        "Hello",
        "--custom",
        "{{UnknownVar}}",
        "--typo",
        "{{TtsOutPutPath}}",
      ],
      expect.any(Object),
    );
  });

  it("passes environment variables correctly", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    mocks.existsSync.mockReturnValue(true);

    const config = {
      command: "say",
      args: ["{{TtsText}}"],
    };

    await cliTTS({
      text: "Hello",
      outputPath: "/tmp/out.opus",
      config,
      outputFormat: "opus",
      timeoutMs: 30000,
    });

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          TTS_TEXT: "Hello",
          TTS_OUTPUT_PATH: "/tmp/out.opus",
          TTS_OUTPUT_FORMAT: "opus",
        }),
      }),
    );
  });

  it("throws error when command returns non-zero code", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "Command not found",
    });

    const config = {
      command: "invalid-command",
      args: ["{{TtsText}}"],
    };

    await expect(
      cliTTS({
        text: "Hello",
        outputPath: "/tmp/out.mp3",
        config,
        outputFormat: "mp3",
        timeoutMs: 30000,
      }),
    ).rejects.toThrow("CLI TTS failed (exit code 1): Command not found");
  });

  it("throws error when process is killed by signal", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: null,
      stdout: "",
      stderr: "",
      signal: "SIGTERM",
      killed: true,
      termination: "timeout",
    });

    await expect(
      cliTTS({
        text: "Hello",
        outputPath: "/tmp/out.mp3",
        config: { command: "slow-tts" },
        outputFormat: "mp3",
        timeoutMs: 100,
      }),
    ).rejects.toThrow("CLI TTS failed (killed by signal SIGTERM)");
  });

  it("throws error when output file is not created", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    mocks.existsSync.mockReturnValue(false);

    const config = {
      command: "say",
      args: ["{{TtsText}}"],
    };

    await expect(
      cliTTS({
        text: "Hello",
        outputPath: "/tmp/missing.mp3",
        config,
        outputFormat: "mp3",
        timeoutMs: 30000,
      }),
    ).rejects.toThrow("CLI TTS did not produce output file: /tmp/missing.mp3");
  });

  it("handles special characters in text safely", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    mocks.existsSync.mockReturnValue(true);

    const config = {
      command: "echo",
      args: ["{{TtsText}}"],
    };

    const dangerousText = "Hello'; rm -rf /; echo 'injection";

    await cliTTS({
      text: dangerousText,
      outputPath: "/tmp/out.mp3",
      config,
      outputFormat: "mp3",
      timeoutMs: 30000,
    });

    // Verify the dangerous text is passed as-is (templating doesn't execute it)
    expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(
      ["echo", dangerousText],
      expect.any(Object),
    );
  });

  it("handles empty args array", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    mocks.existsSync.mockReturnValue(true);

    const config = {
      command: "say",
      args: [],
    };

    await cliTTS({
      text: "Hello",
      outputPath: "/tmp/out.mp3",
      config,
      outputFormat: "mp3",
      timeoutMs: 30000,
    });

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(["say"], expect.any(Object));
  });

  it("handles undefined args", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    mocks.existsSync.mockReturnValue(true);

    const config = {
      command: "say",
    };

    await cliTTS({
      text: "Hello",
      outputPath: "/tmp/out.mp3",
      config,
      outputFormat: "mp3",
      timeoutMs: 30000,
    });

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(["say"], expect.any(Object));
  });

  it("preserves process.env in env", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    mocks.existsSync.mockReturnValue(true);

    const config = {
      command: "say",
      args: ["{{TtsText}}"],
    };

    await cliTTS({
      text: "Hello",
      outputPath: "/tmp/out.mp3",
      config,
      outputFormat: "mp3",
      timeoutMs: 30000,
    });

    const callArgs = mocks.runCommandWithTimeout.mock.calls[0];
    const envArg = callArgs?.[1]?.env as Record<string, string | undefined>;
    expect(envArg).toHaveProperty("PATH");
  });

  it("handles multi-line text", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    mocks.existsSync.mockReturnValue(true);

    const config = {
      command: "echo",
      args: ["{{TtsText}}"],
    };

    const multiLineText = "Line 1\nLine 2\nLine 3";

    await cliTTS({
      text: multiLineText,
      outputPath: "/tmp/out.mp3",
      config,
      outputFormat: "mp3",
      timeoutMs: 30000,
    });

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(
      ["echo", multiLineText],
      expect.any(Object),
    );
  });

  it("handles pcm output format", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    mocks.existsSync.mockReturnValue(true);

    const config = {
      command: "tts-cli",
      args: ["--format", "{{TtsOutputFormat}}", "--output", "{{TtsOutputPath}}"],
    };

    await cliTTS({
      text: "Hello",
      outputPath: "/tmp/out.wav",
      config,
      outputFormat: "pcm",
      timeoutMs: 30000,
    });

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(
      ["tts-cli", "--format", "pcm", "--output", "/tmp/out.wav"],
      expect.any(Object),
    );
  });
});
