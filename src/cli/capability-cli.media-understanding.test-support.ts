import path from "node:path";
import { expect, it, type Mock } from "vitest";
import { interruptCapability } from "./capability-cli.embedding.test-support.js";
import { runCap } from "./capability-cli.test-harness.js";

function cliOptions(options: Record<string, string | number | true | string[] | undefined>) {
  return Object.entries(options).flatMap(([name, value]) =>
    value === undefined
      ? []
      : value === true
        ? [`--${name}`]
        : (Array.isArray(value) ? value : [String(value)]).flatMap((entry) => [`--${name}`, entry]),
  );
}

export function registerMediaUnderstandingCapabilityCliTests({
  transcribeAudioFile,
  runtimeLog,
}: {
  transcribeAudioFile: Mock;
  runtimeLog: Mock;
}): void {
  it("reports actual audio attribution and forwards request hints", async () => {
    transcribeAudioFile.mockResolvedValueOnce({
      text: "meeting notes",
      provider: "fixture-asr",
      model: "fixture-actual-model",
    });
    await runCap(
      "infer",
      "audio",
      "transcribe",
      ...cliOptions({
        file: "memo.m4a",
        model: "openai/whisper-1",
        language: "en",
        prompt: "Focus on names",
      }),
    );
    // Forwarded request hints land in the first argument; the optional execution
    // fence varies with invocation scope, so assert only the transcription params.
    expect(transcribeAudioFile.mock.calls[0]?.[0]).toMatchObject({
      language: "en",
      prompt: "Focus on names",
    });
    const output = runtimeLog.mock.calls.at(-1)?.[0];
    expect(output).toContain("provider: fixture-asr");
    expect(output).toContain("model: fixture-actual-model");
    expect(output).toContain(path.resolve("memo.m4a"));
    expect(output).toContain("meeting notes");
  });

  it("cancels a pending audio transcription and suppresses output on interrupt", async () => {
    await interruptCapability((waitForAbort) => {
      transcribeAudioFile.mockImplementationOnce((_params, execution) =>
        waitForAbort(execution?.signal),
      );
      return runCap(
        "infer",
        "audio",
        "transcribe",
        ...cliOptions({ file: "memo.m4a", json: true }),
      );
    });
    // The accepted interrupt forwards cancellation to the pending provider request
    // instead of letting it finish and then publishing its late transcript.
    expect(runtimeLog).not.toHaveBeenCalledWith(expect.stringContaining("audio.transcription"));
  });
}
