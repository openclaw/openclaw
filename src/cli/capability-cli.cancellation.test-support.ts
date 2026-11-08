// Cancellation matrix: an accepted interrupt must reach every outbound request owner,
// including the TTS Gateway RPCs that print no output of their own.
import { expect, it, type Mock } from "vitest";
import { interruptCapability, runCap, runCapability } from "./capability-cli.test-harness.js";

const ttsGatewayArgv: Record<string, [string, ...string[]]> = {
  tts: ["convert", "--text", "hello", "--gateway", "--json"],
  "tts-providers": ["providers", "--gateway", "--json"],
  "tts-personas": ["personas", "--gateway", "--json"],
  "tts-status": ["status", "--gateway", "--json"],
  "tts-set-provider": ["set-provider", "--provider", "openai", "--gateway", "--json"],
};

export function registerCapabilityCancellationTests({
  mocks,
  runModelProbe,
}: {
  mocks: {
    callGateway: Mock;
    completeWithPreparedSimpleCompletionModel: Mock;
    releaseSimpleCompletion: Mock;
    transcribeAudioFile: Mock;
    describeImageFile: Mock;
    describePreparedImageWithModel: Mock;
    runtime: { writeJson: Mock; log: Mock; error: Mock };
  };
  runModelProbe: (...args: string[]) => Promise<void>;
}): void {
  it.each(["local", "gateway", "audio", ...Object.keys(ttsGatewayArgv), "image", "image-model"])(
    "cancels pending %s execution",
    async (kind) => {
      await interruptCapability((waitForAbort) => {
        const ttsArgv = ttsGatewayArgv[kind];
        if (ttsArgv) {
          mocks.callGateway.mockImplementationOnce(({ signal }) => waitForAbort(signal));
          return runCapability("tts", ...ttsArgv);
        }
        if (kind === "gateway") {
          mocks.callGateway.mockImplementationOnce(({ signal }) => waitForAbort(signal));
        } else if (kind === "local") {
          mocks.completeWithPreparedSimpleCompletionModel.mockImplementationOnce(({ options }) =>
            waitForAbort(options?.signal),
          );
        } else if (kind === "audio") {
          mocks.transcribeAudioFile.mockImplementationOnce((_params, execution) =>
            waitForAbort(execution?.signal),
          );
          return runCap("infer", "audio", "transcribe", "--file", "memo.m4a", "--json");
        } else if (kind === "image" || kind === "image-model") {
          const describeImage =
            kind === "image" ? mocks.describeImageFile : mocks.describePreparedImageWithModel;
          describeImage.mockImplementationOnce((_params, execution) =>
            waitForAbort(execution?.signal),
          );
          return runCapability(
            "image",
            "describe",
            "--file",
            "photo.jpg",
            ...(kind === "image-model" ? ["--model", "ollama/vision"] : []),
            "--json",
          );
        }
        return runModelProbe(...(kind === "gateway" ? ["--gateway"] : []));
      });
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
      expect(mocks.runtime.log).not.toHaveBeenCalled();
      expect(mocks.runtime.error).not.toHaveBeenCalled();
      expect(mocks.releaseSimpleCompletion).toHaveBeenCalledTimes(kind === "local" ? 1 : 0);
    },
  );
}
