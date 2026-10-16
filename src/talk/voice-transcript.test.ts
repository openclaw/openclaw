import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  VoiceTranscriptOperationRegistry,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "./voice-transcript.js";

describe("VoiceTranscriptOperationRegistry", () => {
  it("rejects close after an accepted operation fails and releases the failed owner", async () => {
    const registry = new VoiceTranscriptOperationRegistry();
    const first = createDeferred();
    const key = "agent\0voice-failure";
    const active = registry.run(key, () => first.promise);
    const failure = new Error("persistence failed");
    const failed = registry.run(key, () => {
      throw failure;
    });
    const closeOperation = vi.fn(async () => undefined);
    const closed = registry.close(key, closeOperation);
    const completions = Promise.all([
      expect(active).resolves.toBeUndefined(),
      expect(failed).rejects.toBe(failure),
      expect(closed).rejects.toBe(failure),
    ]);

    first.resolve();
    await completions;

    expect(closeOperation).not.toHaveBeenCalled();
    await expect(registry.run(key, async () => "fresh owner")).resolves.toBe("fresh owner");
  });

  it("keeps overflow terminal through drain and releases it only on close", async () => {
    const registry = new VoiceTranscriptOperationRegistry();
    const first = createDeferred();
    const key = "agent\0voice-overflow";
    const accepted = [
      registry.run(key, async () => await first.promise),
      ...Array.from({ length: VOICE_TRANSCRIPT_QUEUE_POLICY.maxPendingCount }, () =>
        registry.run(key, async () => undefined),
      ),
    ];

    await expect(registry.run(key, async () => undefined)).rejects.toThrow(
      "voice transcript persistence queue capacity exceeded",
    );
    first.resolve();
    await Promise.all(accepted);

    const controlOperation = vi.fn();
    await expect(registry.run(key, controlOperation, { weight: 0 })).rejects.toThrow(
      "voice transcript persistence queue capacity exceeded",
    );
    expect(controlOperation).not.toHaveBeenCalled();

    const closeOperation = vi.fn();
    await registry.close(key, async () => {
      closeOperation();
    });
    expect(closeOperation).toHaveBeenCalledOnce();
    await expect(registry.run(key, controlOperation, { weight: 0 })).resolves.toBeUndefined();
    expect(controlOperation).toHaveBeenCalledOnce();
  });
});
