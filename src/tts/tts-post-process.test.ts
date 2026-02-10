import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { textToSpeech } from "./tts.js";

describe("TTS post-processing", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "tts-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("should skip post-processing when disabled", async () => {
    const config: OpenClawConfig = {
      messages: {
        tts: {
          provider: "edge",
          edge: { enabled: true },
          postProcess: {
            enabled: false,
            command: "/bin/echo",
          },
        },
      },
    };

    const result = await textToSpeech({
      text: "Test message",
      cfg: config,
    });

    expect(result.success).toBe(true);
    expect(result.audioPath).toBeDefined();
    // Should not have run post-processing
  });

  it("should skip post-processing when no command configured", async () => {
    const config: OpenClawConfig = {
      messages: {
        tts: {
          provider: "edge",
          edge: { enabled: true },
          postProcess: {
            enabled: true,
            // No command
          },
        },
      },
    };

    const result = await textToSpeech({
      text: "Test message",
      cfg: config,
    });

    expect(result.success).toBe(true);
    expect(result.audioPath).toBeDefined();
  });

  it("should apply passthrough post-processing with cat command", async () => {
    const config: OpenClawConfig = {
      messages: {
        tts: {
          provider: "edge",
          edge: { enabled: true },
          postProcess: {
            enabled: true,
            command: path.join(tempDir, "passthrough.sh"),
            timeoutMs: 5000,
          },
        },
      },
    };

    // Create a simple passthrough script
    const scriptPath = path.join(tempDir, "passthrough.sh");
    writeFileSync(scriptPath, `#!/bin/bash\ncp "$OPENCLAW_TTS_INPUT" "$OPENCLAW_TTS_OUTPUT"\n`, {
      mode: 0o755,
    });

    const result = await textToSpeech({
      text: "Test message",
      cfg: config,
    });

    expect(result.success).toBe(true);
    expect(result.audioPath).toBeDefined();
    expect(existsSync(result.audioPath!)).toBe(true);
  });

  it("should fallback to original audio on post-processing failure", async () => {
    const config: OpenClawConfig = {
      messages: {
        tts: {
          provider: "edge",
          edge: { enabled: true },
          postProcess: {
            enabled: true,
            command: "/bin/false", // Always fails
            timeoutMs: 1000,
          },
        },
      },
    };

    const result = await textToSpeech({
      text: "Test message",
      cfg: config,
    });

    expect(result.success).toBe(true);
    expect(result.audioPath).toBeDefined();
    // Should have fallen back to original audio
  });

  it("should pass environment variables to post-processing command", async () => {
    const config: OpenClawConfig = {
      messages: {
        tts: {
          provider: "edge",
          edge: { enabled: true },
          postProcess: {
            enabled: true,
            command: path.join(tempDir, "check-env.sh"),
            timeoutMs: 5000,
            env: {
              TEST_VAR: "test-value",
            },
          },
        },
      },
    };

    // Create a script that checks for env var and creates output
    const scriptPath = path.join(tempDir, "check-env.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash\nif [ "$TEST_VAR" = "test-value" ]; then\n  cp "$OPENCLAW_TTS_INPUT" "$OPENCLAW_TTS_OUTPUT"\nelse\n  exit 1\nfi\n`,
      { mode: 0o755 },
    );

    const result = await textToSpeech({
      text: "Test message",
      cfg: config,
    });

    expect(result.success).toBe(true);
    expect(result.audioPath).toBeDefined();
  });

  it("should timeout long-running post-processing commands", async () => {
    const config: OpenClawConfig = {
      messages: {
        tts: {
          provider: "edge",
          edge: { enabled: true },
          postProcess: {
            enabled: true,
            command: path.join(tempDir, "slow.sh"),
            timeoutMs: 500,
          },
        },
      },
    };

    // Create a script that sleeps longer than timeout
    const scriptPath = path.join(tempDir, "slow.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/bash\nsleep 10\ncp "$OPENCLAW_TTS_INPUT" "$OPENCLAW_TTS_OUTPUT"\n`,
      { mode: 0o755 },
    );

    const result = await textToSpeech({
      text: "Test message",
      cfg: config,
    });

    expect(result.success).toBe(true);
    expect(result.audioPath).toBeDefined();
    // Should have timed out and fallen back to original
  });
});
