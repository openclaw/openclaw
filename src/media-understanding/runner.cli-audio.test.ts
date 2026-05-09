import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { CLI_OUTPUT_MAX_BUFFER } from "./defaults.constants.js";
import { withAudioFixture } from "./runner.test-utils.js";

const runExecMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runExec: (...args: unknown[]) => runExecMock(...args),
}));

let runCliEntry: typeof import("./runner.entries.js").runCliEntry;

describe("media-understanding CLI audio entry", () => {
  beforeAll(async () => {
    ({ runCliEntry } = await import("./runner.entries.js"));
  });

  beforeEach(() => {
    runExecMock.mockReset().mockResolvedValue({ stdout: "cli transcript" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("applies per-request prompt and language overrides to CLI transcription templating", async () => {
    await withAudioFixture("openclaw-cli-audio", async ({ ctx, cache }) => {
      await runCliEntry({
        capability: "audio",
        entry: {
          type: "cli",
          command: "mock-transcriber",
          args: ["--prompt", "{{Prompt}}", "--language", "{{Language}}", "--file", "{{MediaPath}}"],
          prompt: "entry prompt",
          language: "de",
        },
        cfg: {
          tools: {
            media: {
              audio: {
                prompt: "configured prompt",
                language: "fr",
                _requestPromptOverride: "Focus on names",
                _requestLanguageOverride: "en",
              },
            },
          },
        } as OpenClawConfig,
        ctx,
        attachmentIndex: 0,
        cache,
        config: {
          prompt: "configured prompt",
          language: "fr",
          _requestPromptOverride: "Focus on names",
          _requestLanguageOverride: "en",
        } as never,
      });
    });

    const [command, args, options] = runExecMock.mock.calls[0] ?? [];
    expect(command).toBe("mock-transcriber");
    expect(args).toEqual(
      expect.arrayContaining(["--prompt", "Focus on names", "--language", "en"]),
    );
    expect(options).toEqual({
      timeoutMs: 60_000,
      maxBuffer: CLI_OUTPUT_MAX_BUFFER,
    });
  });
});
