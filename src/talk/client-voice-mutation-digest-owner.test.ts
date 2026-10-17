import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { ClientVoiceMutationDigestOwner } from "./client-voice-mutation-digest-owner.js";

async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("client voice mutation digest owner", () => {
  const owners: Array<{ clear(): void }> = [];
  function makeOwner<T>(
    options: Omit<ConstructorParameters<typeof ClientVoiceMutationDigestOwner<T>>[0], "warn"> & {
      warn?: (message: string) => void;
    },
  ) {
    const owner = new ClientVoiceMutationDigestOwner<T>({ warn: vi.fn(), ...options });
    owners.push(owner);
    return owner;
  }
  function capture(releases: Array<ReturnType<typeof vi.fn>>) {
    const release = vi.fn();
    releases.push(release);
    return { run: <T>(run: () => T) => run(), release };
  }
  const identity = { agentId: "a", voiceSessionId: "v1" };
  const record = (
    owner: ClientVoiceMutationDigestOwner<number>,
    context: number,
    voiceSessionId = "v1",
  ) => owner.record({ agentId: "a", voiceSessionId, context });
  function pendingOwner() {
    let active = 0;
    let maxActive = 0;
    const warn = vi.fn();
    const attempts: Array<{
      id: string;
      context: number;
      signal: AbortSignal;
      completion: ReturnType<typeof createDeferred<boolean>>;
    }> = [];
    const owner = makeOwner<number>({
      warn,
      attempt: async ({ voiceSessionId: id, context, signal }) => {
        const completion = createDeferred<boolean>();
        attempts.push({ id, context, signal, completion });
        maxActive = Math.max(maxActive, ++active);
        try {
          return await completion.promise;
        } finally {
          active--;
        }
      },
    });
    return { owner, attempts, warn, maxActive: () => maxActive };
  }
  const expectReleased = (releases: Array<ReturnType<typeof vi.fn>>) =>
    releases.forEach((release) => expect(release).toHaveBeenCalledOnce());
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => {
    owners.splice(0).forEach((owner) => owner.clear());
    vi.useRealTimers();
  });
  it("drains the accepted retry prefix when a later intent loses admission", async () => {
    let retrying = false;
    const refused = new Error("second intent admission closed");
    const releases: ReturnType<typeof vi.fn>[] = [];
    const attempt = vi.fn(async () => retrying);
    const owner = makeOwner<number>({
      attempt,
      updateContext: (previous) => previous,
      captureAttempt(context) {
        if (retrying && context === 2) {
          throw refused;
        }
        return capture(releases);
      },
    });
    record(owner, 1, "first");
    record(owner, 2, "second");
    await flushMicrotasks();
    expect(owner.snapshot()).toMatchObject({ active: 0, retained: 2 });
    retrying = true;
    expect(() => owner.retryAgent("a", 0)).toThrow(refused);
    await flushMicrotasks();
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 });
    expect(releases).toHaveLength(3);
    expectReleased(releases);
  });
  it("bounds retained identities, dedupes keys, and limits concurrency", async () => {
    const { owner, attempts, warn, maxActive } = pendingOwner();
    for (let index = 1; index <= 66; index += 1) {
      owner.record({ agentId: "a", voiceSessionId: `v${index}`, context: index });
    }
    record(owner, 99);
    expect(owner.snapshot()).toEqual({ active: 2, pending: 62, retained: 64 });
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
    expect(owner.snapshot()).toEqual({ active: 0, pending: 0, retained: 0 });
    expect(attempts.map((attempt) => attempt.id)).toEqual(
      Array.from({ length: 64 }, (_, index) => `v${index + 1}`),
    );
    expect(maxActive()).toBe(2);
    expect(warn.mock.calls).toEqual([
      ["voice mutation digest retry owner is full"],
      ["voice mutation digest retry owner is full"],
    ]);
  });

  it.each([
    { error: new Error("offline"), expectedAttempts: 2 },
    { error: new SqliteWorkerError("lost acknowledgment", "outcome-unknown"), expectedAttempts: 1 },
  ])(
    "retries duplicate intent only after a known failure ($error)",
    async ({ error, expectedAttempts }) => {
      const { owner, attempts } = pendingOwner();
      record(owner, 1);
      record(owner, 2);
      attempts[0]?.completion.reject(error);
      await flushMicrotasks();
      expect(attempts).toHaveLength(expectedAttempts);
      attempts[1]?.completion.resolve(true);
      await flushMicrotasks();
      expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0 });
    },
  );

  it.each(["unknown outcome", "confirmed delivery"] as const)(
    "fences later lifecycle intents after %s without retaining settlement",
    async (fence) => {
      const confirmed = fence === "confirmed delivery";
      const releases: Array<ReturnType<typeof vi.fn>> = [];
      const attempt = vi.fn<() => Promise<boolean>>();
      if (confirmed) {
        attempt.mockRejectedValue(new Error("marker refused"));
      } else {
        attempt
          .mockRejectedValueOnce(new Error("offline"))
          .mockRejectedValueOnce(new SqliteWorkerError("lost acknowledgment", "outcome-unknown"))
          .mockResolvedValue(true);
      }
      const owner = makeOwner<number>({
        attempt,
        captureAttempt: () => capture(releases),
        ...(confirmed ? { deliveryState: () => "confirmed" as const } : {}),
      });
      record(owner, 1);
      await flushMicrotasks();
      if (!confirmed) {
        owner.retry(identity);
        await flushMicrotasks();
        expect(releases).toHaveLength(2);
        expectReleased(releases);
      }
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      const expectedAttempts = confirmed ? attempt.mock.calls.length : 2;
      if (confirmed) {
        record(owner, 1);
      }
      owner.retry(identity);
      owner.retryAgent("a", confirmed ? 1 : 2);
      if (!confirmed) {
        record(owner, 3);
      }
      await flushMicrotasks();
      expect(attempt).toHaveBeenCalledTimes(expectedAttempts);
      expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 });
      expectReleased(releases);
      if (!confirmed) {
        expect(releases).toHaveLength(2);
        owner.record({ agentId: "a", voiceSessionId: "v2", context: 1 });
        await flushMicrotasks();
        expect(attempt).toHaveBeenCalledTimes(3);
        expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 });
      }
    },
  );

  it("keeps an ignored abort request active until its real promise settles", async () => {
    const { owner, attempts } = pendingOwner();
    try {
      record(owner, 1);
      record(owner, 2, "v2");
      record(owner, 3, "v3");
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

  it("releases queued acceptance on reset but joins active attempts until they settle", async () => {
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const attempts: Array<ReturnType<typeof createDeferred<boolean>>> = [];
    const owner = makeOwner<number>({
      captureAttempt: () => capture(releases),
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

  it("drops a permanently failing intent after bounded lifecycle retries", async () => {
    const warn = vi.fn();
    const attempts: string[] = [];
    const owner = makeOwner<number>({
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

  it("suspends failure expiry while a legitimate defer owns the retry", async () => {
    let outcome: "fail" | "defer" | "succeed" = "fail";
    const attempt = vi.fn(async () => {
      if (outcome === "fail") {
        throw new Error("offline");
      }
      return outcome === "succeed";
    });
    const owner = makeOwner<number>({ attempt });
    record(owner, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 });
    outcome = "defer";
    owner.retry(identity);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300_001);
    expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 });
    outcome = "succeed";
    owner.retry(identity);
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.snapshot().retained).toBe(0);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("ignores settlement from an attempt owned by a cleared generation", async () => {
    const { owner, attempts } = pendingOwner();
    record(owner, 1);
    owner.clear();
    record(owner, 2);
    record(owner, 3);
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
