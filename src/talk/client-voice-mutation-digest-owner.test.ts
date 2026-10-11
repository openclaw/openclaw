import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { ClientVoiceMutationDigestOwner } from "./client-voice-mutation-digest-owner.js";

async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("client voice mutation digest owner", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());
  it("drains the accepted retry prefix when a later intent loses admission", async () => {
    let retrying = false;
    const refused = new Error("second intent admission closed");
    const releases: ReturnType<typeof vi.fn>[] = [];
    const attempt = vi.fn(async () => retrying);
    const owner = new ClientVoiceMutationDigestOwner<number>({
      attempt,
      warn: vi.fn(),
      updateContext: (previous) => previous,
      captureAttempt(context) {
        if (retrying && context === 2) {
          throw refused;
        }
        const release = vi.fn();
        releases.push(release);
        return { run: (run) => run(), release };
      },
    });
    try {
      owner.record({ agentId: "a", voiceSessionId: "first", context: 1 });
      owner.record({ agentId: "a", voiceSessionId: "second", context: 2 });
      await flushMicrotasks();
      expect(owner.snapshot()).toMatchObject({ active: 0, retained: 2 });
      retrying = true;
      expect(() => owner.retryAgent("a", 0)).toThrow(refused);
      await flushMicrotasks();
      expect(attempt).toHaveBeenCalledTimes(3);
      expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 });
      expect(releases).toHaveLength(3);
      for (const release of releases) {
        expect(release).toHaveBeenCalledOnce();
      }
    } finally {
      owner.clear();
    }
  });
  it("bounds retained identities, dedupes keys, and limits concurrency", async () => {
    const attempts: Array<{ id: string; completion: ReturnType<typeof createDeferred<boolean>> }> =
      [];
    let active = 0;
    let maxActive = 0;
    const warn = vi.fn();
    const owner = new ClientVoiceMutationDigestOwner<number>({
      warn,
      attempt: async ({ voiceSessionId }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const completion = createDeferred<boolean>();
        attempts.push({ id: voiceSessionId, completion });
        try {
          return await completion.promise;
        } finally {
          active -= 1;
        }
      },
    });

    for (let index = 1; index <= 66; index += 1) {
      owner.record({ agentId: "a", voiceSessionId: `v${index}`, context: index });
    }
    owner.record({ agentId: "a", voiceSessionId: "v1", context: 99 });
    expect(owner.snapshot()).toEqual({
      active: 2,
      pending: 62,
      retained: 64,
      retainedIdentityBytes: 311,
    });

    let resolved = 0;
    while (resolved < 64) {
      await flushMicrotasks();
      expect(attempts.length).toBeGreaterThan(resolved);
      const batch = attempts.slice(resolved);
      resolved += batch.length;
      for (const attempt of batch) {
        attempt.completion.resolve(true);
      }
    }
    await flushMicrotasks();
    expect(owner.snapshot()).toEqual({
      active: 0,
      pending: 0,
      retained: 0,
      retainedIdentityBytes: 0,
    });
    expect(attempts.map((attempt) => attempt.id)).toEqual(
      Array.from({ length: 64 }, (_, index) => `v${index + 1}`),
    );
    expect(attempts.map((attempt) => attempt.id)).not.toContain("v65");
    expect(attempts.map((attempt) => attempt.id)).not.toContain("v66");
    expect(maxActive).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, "voice mutation digest retry owner is full");
    expect(warn).toHaveBeenNthCalledWith(2, "voice mutation digest retry owner is full");
  });

  it.each([
    { error: new Error("offline"), expectedAttempts: 2 },
    { error: new SqliteWorkerError("lost acknowledgment", "outcome-unknown"), expectedAttempts: 1 },
  ])(
    "retries duplicate intent only after a known failure ($error)",
    async ({ error, expectedAttempts }) => {
      const attempts: Array<ReturnType<typeof createDeferred<boolean>>> = [];
      const owner = new ClientVoiceMutationDigestOwner<number>({
        warn: vi.fn(),
        attempt: async () => {
          const completion = createDeferred<boolean>();
          attempts.push(completion);
          return await completion.promise;
        },
      });

      owner.record({ agentId: "a", voiceSessionId: "v1", context: 1 });
      owner.record({ agentId: "a", voiceSessionId: "v1", context: 2 });
      attempts[0]?.reject(error);
      await flushMicrotasks();
      expect(attempts).toHaveLength(expectedAttempts);
      attempts[1]?.resolve(true);
      await flushMicrotasks();
      expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0 });
    },
  );

  it("fences later lifecycle intents after an unknown outcome without retaining settlement", async () => {
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new SqliteWorkerError("lost acknowledgment", "outcome-unknown"))
      .mockResolvedValue(true);
    const owner = new ClientVoiceMutationDigestOwner<number>({
      warn: vi.fn(),
      attempt,
      captureAttempt: () => {
        const release = vi.fn();
        releases.push(release);
        return { run: (run) => run(), release };
      },
    });
    const identity = { agentId: "a", voiceSessionId: "v1" };
    owner.record({ ...identity, context: 1 });
    await flushMicrotasks();
    owner.retry(identity);
    await flushMicrotasks();
    expect(releases).toHaveLength(2);
    for (const release of releases) {
      expect(release).toHaveBeenCalledOnce();
    }
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    owner.retry(identity);
    owner.retryAgent("a", 2);
    owner.record({ ...identity, context: 3 });
    await flushMicrotasks();
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(releases).toHaveLength(2);
    owner.record({ agentId: "a", voiceSessionId: "v2", context: 1 });
    await flushMicrotasks();
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 });
    owner.clear();
  });

  it.each(["attempt limit", "expiry"] as const)(
    "retains a confirmed-delivery fence after marker retry %s",
    async (limit) => {
      const releases: Array<ReturnType<typeof vi.fn>> = [];
      const attempt = vi.fn(async () => {
        throw new Error("marker refused");
      });
      const owner = new ClientVoiceMutationDigestOwner<{ deliveredAt: number }>({
        warn: vi.fn(),
        attempt,
        deliveryState: () => "confirmed",
        captureAttempt: () => {
          const release = vi.fn();
          releases.push(release);
          return { run: (run) => run(), release };
        },
      });
      const identity = { agentId: "a", voiceSessionId: "v1" };
      const context = { deliveredAt: 123 };
      owner.record({ ...identity, context });
      await flushMicrotasks();
      if (limit === "attempt limit") {
        for (let index = 0; index < 2; index += 1) {
          owner.retry(identity);
          await flushMicrotasks();
        }
      }
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      const attempts = attempt.mock.calls.length;
      owner.record({ ...identity, context });
      owner.retry(identity);
      owner.retryAgent("a", context);
      await flushMicrotasks();
      expect(attempt).toHaveBeenCalledTimes(attempts);
      expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 });
      for (const release of releases) {
        expect(release).toHaveBeenCalledOnce();
      }
      owner.clear();
    },
  );

  it("keeps an ignored abort request active until its real promise settles", async () => {
    const attempts: Array<{
      completion: ReturnType<typeof createDeferred<boolean>>;
      signal: AbortSignal;
    }> = [];
    const owner = new ClientVoiceMutationDigestOwner<number>({
      warn: vi.fn(),
      attempt: async ({ signal }) => {
        const completion = createDeferred<boolean>();
        attempts.push({ completion, signal });
        return await completion.promise;
      },
    });

    try {
      owner.record({ agentId: "a", voiceSessionId: "v1", context: 1 });
      owner.record({ agentId: "a", voiceSessionId: "v2", context: 2 });
      owner.record({ agentId: "a", voiceSessionId: "v3", context: 3 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.signal.aborted).toBe(true);
      expect(owner.snapshot()).toMatchObject({ active: 2, pending: 1, retained: 3 });

      attempts[0]?.completion.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(3);
      attempts[1]?.completion.resolve(true);
      attempts[2]?.completion.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.snapshot().retained).toBe(0);
    } finally {
      for (const attempt of attempts) {
        attempt.completion.resolve(true);
      }
      owner.clear();
    }
  });

  it("rejects an oversized identity atomically", async () => {
    const warn = vi.fn();
    const attempt = vi.fn(async () => true);
    const owner = new ClientVoiceMutationDigestOwner<number>({
      warn,
      attempt,
    });

    owner.record({ agentId: "agent", voiceSessionId: "v".repeat(65_536), context: 1 });
    await flushMicrotasks();

    expect(owner.snapshot()).toEqual({
      active: 0,
      pending: 0,
      retained: 0,
      retainedIdentityBytes: 0,
    });
    expect(attempt).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "voice mutation digest identity exceeds the retry owner byte limit",
    );
  });

  it("releases queued acceptance on reset but joins active attempts until they settle", async () => {
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const attempts: Array<ReturnType<typeof createDeferred<boolean>>> = [];
    const owner = new ClientVoiceMutationDigestOwner<number>({
      warn: vi.fn(),
      captureAttempt: () => {
        const release = vi.fn();
        releases.push(release);
        return { run: (run) => run(), release };
      },
      attempt: async () => {
        const completion = createDeferred<boolean>();
        attempts.push(completion);
        return completion.promise;
      },
    });
    for (let index = 0; index < 3; index++) {
      owner.record({ agentId: "main", voiceSessionId: String(index), context: index });
    }
    owner.clear();
    expect(releases.map((release) => release.mock.calls.length)).toEqual([0, 0, 1]);
    attempts[0]!.reject(new Error("unknown delivery outcome"));
    attempts[1]!.resolve(true);
    await flushMicrotasks();
    expect(releases.map((release) => release.mock.calls.length)).toEqual([1, 1, 1]);
    expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 0 });
  });

  it("preserves older intents when aggregate identity bytes are full", async () => {
    const attempts: Array<{ id: string; completion: ReturnType<typeof createDeferred<boolean>> }> =
      [];
    const warn = vi.fn();
    const owner = new ClientVoiceMutationDigestOwner<number>({
      warn,
      attempt: async ({ voiceSessionId }) => {
        const completion = createDeferred<boolean>();
        attempts.push({ id: voiceSessionId, completion });
        return await completion.promise;
      },
    });

    const agentId = "a".repeat(32_765);
    owner.record({ agentId, voiceSessionId: "v1", context: 1 });
    owner.record({ agentId, voiceSessionId: "v2", context: 2 });
    owner.record({ agentId, voiceSessionId: "v3", context: 3 });

    expect(owner.snapshot()).toEqual({
      active: 2,
      pending: 0,
      retained: 2,
      retainedIdentityBytes: 65_536,
    });
    expect(warn).toHaveBeenCalledOnce();

    attempts[0]?.completion.resolve(true);
    await flushMicrotasks();
    expect(attempts).toHaveLength(2);
    attempts[1]?.completion.resolve(true);
    await flushMicrotasks();
    expect(owner.snapshot().retained).toBe(0);
    expect(attempts.map((attempt) => attempt.id)).toEqual(["v1", "v2"]);
  });

  it("drops a permanently failing intent after bounded lifecycle retries", async () => {
    const warn = vi.fn();
    const attempts: string[] = [];
    const owner = new ClientVoiceMutationDigestOwner<number>({
      warn,
      attempt: async ({ agentId }) => {
        attempts.push(agentId);
        if (agentId === "first") {
          throw new Error("permanent");
        }
        return true;
      },
    });

    owner.record({ agentId: "first", voiceSessionId: "v1", context: 1 });
    await flushMicrotasks();
    expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 });
    owner.retry({ agentId: "first", voiceSessionId: "v1" });
    await flushMicrotasks();
    expect(attempts).toHaveLength(2);
    await flushMicrotasks();
    expect(owner.snapshot().active).toBe(0);
    owner.retry({ agentId: "first", voiceSessionId: "v1" });
    await flushMicrotasks();
    expect(owner.snapshot().retained).toBe(0);

    owner.record({ agentId: "second", voiceSessionId: "v2", context: 2 });
    await flushMicrotasks();
    expect(owner.snapshot().retained).toBe(0);
    expect(attempts).toEqual(["first", "first", "first", "second"]);
    expect(warn).toHaveBeenLastCalledWith(
      "voice mutation digest dropped after 3 failed attempts: permanent",
    );
  });

  it("expires a failed intent without self-retrying", async () => {
    try {
      const warn = vi.fn();
      const attempt = vi.fn(async () => {
        throw new Error("offline");
      });
      const owner = new ClientVoiceMutationDigestOwner<number>({
        warn,
        attempt,
      });

      owner.record({ agentId: "a", voiceSessionId: "v1", context: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempt).toHaveBeenCalledOnce();
      expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 });

      await vi.advanceTimersByTimeAsync(299_999);
      expect(owner.snapshot().retained).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(owner.snapshot().retained).toBe(0);
      expect(attempt).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenLastCalledWith(
        "voice mutation digest dropped after retry retention expired (1 failed attempts)",
      );
    } finally {
      vi.clearAllTimers();
    }
  });

  it("suspends failure expiry while a legitimate defer owns the retry", async () => {
    try {
      let outcome: "fail" | "defer" | "succeed" = "fail";
      const attempt = vi.fn(async () => {
        if (outcome === "fail") {
          throw new Error("offline");
        }
        return outcome === "succeed";
      });
      const owner = new ClientVoiceMutationDigestOwner<number>({
        warn: vi.fn(),
        attempt,
      });

      owner.record({ agentId: "a", voiceSessionId: "v1", context: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 });

      outcome = "defer";
      owner.retry({ agentId: "a", voiceSessionId: "v1" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(300_001);
      expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 });

      outcome = "succeed";
      owner.retry({ agentId: "a", voiceSessionId: "v1" });
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.snapshot().retained).toBe(0);
      expect(attempt).toHaveBeenCalledTimes(3);
    } finally {
      vi.clearAllTimers();
    }
  });

  it("ignores settlement from an attempt owned by a cleared generation", async () => {
    const attempts: Array<{
      context: number;
      completion: ReturnType<typeof createDeferred<boolean>>;
    }> = [];
    const owner = new ClientVoiceMutationDigestOwner<number>({
      warn: vi.fn(),
      attempt: async ({ context }) => {
        const completion = createDeferred<boolean>();
        attempts.push({ context, completion });
        return await completion.promise;
      },
    });

    owner.record({ agentId: "a", voiceSessionId: "v1", context: 1 });
    owner.clear();
    owner.record({ agentId: "a", voiceSessionId: "v1", context: 2 });
    owner.record({ agentId: "a", voiceSessionId: "v1", context: 3 });

    attempts[0]?.completion.reject(new Error("old generation"));
    attempts[1]?.completion.resolve(false);
    await flushMicrotasks();
    expect(attempts).toHaveLength(3);
    expect(attempts[2]?.context).toBe(3);
    attempts[2]?.completion.resolve(true);
    await flushMicrotasks();
    expect(owner.snapshot().retained).toBe(0);
  });
});
