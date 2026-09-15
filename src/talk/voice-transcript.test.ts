import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createVoiceTranscriptOperationRegistry,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "./voice-transcript.js";

describe("VoiceTranscriptOperationRegistry", () => {
  it.each([false, true])(
    "rejects close after an accepted operation fails and releases the failed owner (recovery=%s)",
    async (conditional) => {
      const registry = createVoiceTranscriptOperationRegistry(VOICE_TRANSCRIPT_QUEUE_POLICY);
      const first = createDeferred();
      const key = "agent\0voice-failure";
      const active = registry.run(key, () => first.promise);
      const failure = new Error("persistence failed");
      const failed = registry.run(key, () => {
        throw failure;
      });
      const closeOperation = vi.fn(async () => true);
      const closed = registry.close(key, closeOperation, conditional);
      const explicit = conditional ? registry.close(key, closeOperation) : undefined;
      const completions = Promise.all([
        expect(active).resolves.toBeUndefined(),
        expect(failed).rejects.toBe(failure),
        expect(closed).rejects.toBe(failure),
        ...(explicit ? [expect(explicit).rejects.toBe(failure)] : []),
      ]);

      first.resolve();
      await completions;

      expect(closeOperation).not.toHaveBeenCalled();
      await expect(registry.run(key, async () => "fresh owner")).resolves.toBe("fresh owner");
    },
  );

  it("keeps overflow terminal through drain and releases it only on close", async () => {
    const registry = createVoiceTranscriptOperationRegistry(VOICE_TRANSCRIPT_QUEUE_POLICY);
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
    await expect(
      registry.run(key, controlOperation, { weight: 0, waitForCapacity: true }),
    ).rejects.toThrow("voice transcript persistence queue capacity exceeded");
    expect(controlOperation).not.toHaveBeenCalled();

    const closeOperation = vi.fn();
    await registry.close(key, async () => {
      closeOperation();
      return true;
    });
    expect(closeOperation).toHaveBeenCalledOnce();
    await expect(
      registry.run(key, controlOperation, { weight: 0, waitForCapacity: true }),
    ).resolves.toBeUndefined();
    expect(controlOperation).toHaveBeenCalledOnce();
  });
  it("keeps transcript admission sealed while explicit close follows skipped recovery", async () => {
    const registry = createVoiceTranscriptOperationRegistry(VOICE_TRANSCRIPT_QUEUE_POLICY);
    const recoveryGate = createDeferred<boolean>();
    const explicitGate = createDeferred<boolean>();
    const key = "agent\0voice-recovery";
    const recovery = registry.close(key, () => recoveryGate.promise, true);
    const explicitOperation = vi.fn(() => explicitGate.promise);
    const explicit = registry.close(key, explicitOperation);
    try {
      recoveryGate.resolve(false);
      await recovery;
      await expect(registry.run(key, async () => "late transcript")).rejects.toThrow(
        "voice transcript persistence session is closing",
      );
      expect(explicitOperation).toHaveBeenCalledOnce();
    } finally {
      recoveryGate.resolve(false);
      explicitGate.resolve(true);
      await Promise.all([recovery, explicit]);
    }
    expect(await explicit).toBe(true);
  });

  it("skips recovery after later accepted work fails without leaving a pending task", async () => {
    const registry = createVoiceTranscriptOperationRegistry(VOICE_TRANSCRIPT_QUEUE_POLICY);
    const gate = createDeferred();
    const entered = createDeferred();
    const key = "agent\0late-failure";
    const recovery = registry.close(
      key,
      async (trySeal) => {
        entered.resolve();
        await gate.promise;
        return trySeal();
      },
      true,
    );
    await entered.promise;
    const failure = new Error("failed before transcript reservation");
    await expect(
      registry.run(key, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    gate.resolve();
    expect(await recovery).toBe(false);
    await expect(registry.run(key, async () => "retry speech")).resolves.toBe("retry speech");
  });

  it("joins the accepted tail before releasing an explicit close after recovery fails", async () => {
    const registry = createVoiceTranscriptOperationRegistry(VOICE_TRANSCRIPT_QUEUE_POLICY);
    const key = "agent\0failed-recovery-tail";
    const recoveryGate = createDeferred<boolean>();
    const recovery = registry.close(key, () => recoveryGate.promise, true);
    const recoveryFailure = new Error("recovery failed");
    const recoveryResult = expect(recovery).rejects.toBe(recoveryFailure);
    const tailGate = createDeferred();
    const tail = registry.run(key, () => tailGate.promise);
    const closeOperation = vi.fn(async () => true);
    let settled = false;
    const close = registry.close(key, closeOperation);
    const closeResult = expect(close)
      .rejects.toBe(recoveryFailure)
      .then(() => {
        settled = true;
      });
    try {
      recoveryGate.reject(recoveryFailure);
      await recoveryResult;
      expect(settled).toBe(false);
      await expect(registry.run(key, async () => "late speech")).rejects.toThrow(
        "voice transcript persistence session is closing",
      );
    } finally {
      tailGate.resolve();
      await Promise.all([tail, closeResult]);
    }
    expect(closeOperation).not.toHaveBeenCalled();
    await expect(registry.run(key, async () => "fresh owner")).resolves.toBe("fresh owner");
  });

  it("retains overflow after recovery skips the call", async () => {
    const registry = createVoiceTranscriptOperationRegistry(VOICE_TRANSCRIPT_QUEUE_POLICY);
    const key = "agent\0recovery-overflow";
    const recoveryGate = createDeferred<boolean>();
    const recovery = registry.close(key, () => recoveryGate.promise, true);
    const first = createDeferred();
    const accepted = [
      registry.run(key, () => first.promise),
      ...Array.from({ length: VOICE_TRANSCRIPT_QUEUE_POLICY.maxPendingCount }, () =>
        registry.run(key, async () => undefined),
      ),
    ];
    await expect(registry.run(key, async () => undefined)).rejects.toThrow(
      "voice transcript persistence queue capacity exceeded",
    );
    recoveryGate.resolve(false);
    expect(await recovery).toBe(false);
    first.resolve();
    await Promise.all(accepted);
    await expect(registry.run(key, async () => "retry speech")).rejects.toThrow(
      "voice transcript persistence queue capacity exceeded",
    );
    await registry.close(key, async () => true);
    await expect(registry.run(key, async () => "fresh owner")).resolves.toBe("fresh owner");
  });
});
