import { describe, expect, it, vi } from "vitest";
import { createChannelReplayGuard } from "./persistent-dedupe.js";

type ReplayEvent = {
  accountId: string;
  keys: readonly (string | null | undefined)[];
};

function createGuard() {
  return createChannelReplayGuard<ReplayEvent>({
    dedupe: { ttlMs: 10_000, memoryMaxSize: 100 },
    buildReplayKey: (event) => event.keys,
    namespace: (event) => event.accountId,
  });
}

describe("createChannelReplayGuard", () => {
  it("normalizes multi-key claims and mirrors commit state to in-flight waiters", async () => {
    const guard = createGuard();
    const event = { accountId: "work", keys: [" message-1 ", "message-1", "message-2"] };

    await expect(guard.claim(event)).resolves.toEqual({
      kind: "claimed",
      keys: ["message-1", "message-2"],
    });
    const inflight = await guard.claim(event);
    expect(inflight.kind).toBe("inflight");
    await expect(guard.commit(event)).resolves.toBe(true);
    if (inflight.kind === "inflight") {
      await expect(inflight.pending).resolves.toBe(true);
    }
    await expect(guard.claim(event)).resolves.toEqual({ kind: "duplicate" });
  });

  it("fails open for invalid keys without recording them", async () => {
    const guard = createGuard();
    const event = { accountId: "work", keys: [" ", null, undefined] };
    const process = vi.fn(async () => "handled");

    await expect(guard.claim(event)).resolves.toEqual({ kind: "invalid" });
    await expect(guard.shouldProcess(event)).resolves.toBe(true);
    await expect(guard.processGuarded(event, process)).resolves.toEqual({
      kind: "processed",
      value: "handled",
    });
    await expect(guard.commit(event)).resolves.toBe(false);
    expect(process).toHaveBeenCalledOnce();
  });

  it("releases failed claims and rejects their in-flight waiters", async () => {
    const guard = createGuard();
    const event = { accountId: "work", keys: ["message-3"] };

    await expect(guard.claim(event)).resolves.toMatchObject({ kind: "claimed" });
    const inflight = await guard.claim(event);
    const failure = new Error("retry me");
    guard.release(event, { error: failure });
    if (inflight.kind === "inflight") {
      await expect(inflight.pending).rejects.toThrow("retry me");
    }
    await expect(guard.claim(event)).resolves.toMatchObject({ kind: "claimed" });
  });

  it.each([
    { errorMode: "release" as const, nextKind: "claimed" },
    { errorMode: "commit" as const, nextKind: "duplicate" },
  ])("uses $errorMode error settlement in processGuarded", async ({ errorMode, nextKind }) => {
    const guard = createGuard();
    const event = { accountId: "work", keys: [`message-${errorMode}`] };

    await expect(
      guard.processGuarded(
        event,
        async () => {
          throw new Error("handler failed");
        },
        { onError: errorMode },
      ),
    ).rejects.toThrow("handler failed");
    await expect(guard.claim(event)).resolves.toMatchObject({ kind: nextKind });
  });

  it("scopes keys by namespace and supports recency cleanup", async () => {
    const guard = createGuard();
    const work = { accountId: "work", keys: ["message-4"] };
    const home = { accountId: "home", keys: ["message-4"] };

    await expect(guard.shouldProcess(work)).resolves.toBe(true);
    await expect(guard.shouldProcess(work)).resolves.toBe(false);
    await expect(guard.shouldProcess(home)).resolves.toBe(true);
    await expect(guard.hasRecent(work)).resolves.toBe(true);
    await expect(guard.forget(work)).resolves.toBe(true);
    await expect(guard.hasRecent(work)).resolves.toBe(false);
  });
});
