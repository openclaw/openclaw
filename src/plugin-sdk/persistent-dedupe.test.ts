import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { createChannelReplayGuard } from "./persistent-dedupe.js";

type ReplayEvent = {
  accountId: string;
  keys: readonly (string | null | undefined)[];
};

function createGuard() {
  const guard = createChannelReplayGuard<ReplayEvent>({
    dedupe: { ttlMs: 10_000, memoryMaxSize: 100 },
    buildReplayKey: (event) => event.keys,
    namespace: (event) => event.accountId,
  });
  const claimKeys = (...keys: string[]) => guard.claim({ accountId: "work", keys });
  return Object.assign(guard, {
    claimKeys,
    own: async (...keys: string[]) => {
      const claim = await claimKeys(...keys);
      assert(claim.kind === "claimed", `expected claimed result, received ${claim.kind}`);
      return claim.handle;
    },
  });
}

it("fails open for invalid keys without recording them", async () => {
  const guard = createGuard();
  const event = { accountId: "work", keys: [" ", null, undefined] };
  const process = vi.fn(async () => "handled");

  await expect(guard.claim(event)).resolves.toEqual({ kind: "invalid" });
  await expect(guard.shouldProcess(event)).resolves.toBe(true);
  const result = await guard.processGuarded(event, process);
  expect(result).toEqual({ kind: "processed", value: "handled" });
  expect(["commit", "release"].filter((key) => key in guard)).toEqual([]);
  expect(process).toHaveBeenCalledOnce();
});

it("keeps claim keys frozen and isolated from the caller's mutable keys", async () => {
  const guard = createGuard();
  const keys = [" first ", "second", "first"];
  const claim = await guard.claim({ accountId: "work", keys });
  assert(claim.kind === "claimed");
  keys.splice(0, keys.length, "replacement");

  expect(Object.isFrozen(claim.handle.keys)).toBe(true);
  expect(claim.handle.keys).toEqual(["first", "second"]);
  await expect(claim.handle.commit()).resolves.toBe(true);
  await expect(guard.claimKeys("first", "second")).resolves.toEqual({ kind: "duplicate" });
  const replacement = await guard.own("replacement");
  replacement.release();
});

it.each(["first", "second"] as const)("settles only owned keys when %s fails", async (failed) => {
  const guard = createGuard();
  const first = await guard.own("shared", "first-only");
  const second = await guard.own("shared", "second-only");
  expect(second.keys).toEqual(["second-only"]);
  const sharedWaiter = await guard.claimKeys("shared");
  const secondWaiter = await guard.claimKeys("second-only");
  const error = new Error(`${failed} handler failed`);
  if (failed === "first") {
    await expect(second.commit()).resolves.toBe(true);
    first.release({ error });
  } else {
    second.release({ error });
    await expect(first.commit()).resolves.toBe(true);
  }
  assert(sharedWaiter.kind === "inflight" && secondWaiter.kind === "inflight");
  const rejected = { status: "rejected", reason: error };
  const fulfilled = { status: "fulfilled", value: true };
  expect(await Promise.allSettled([sharedWaiter.pending, secondWaiter.pending])).toEqual(
    failed === "first" ? [rejected, fulfilled] : [fulfilled, rejected],
  );
  const sharedKeys = failed === "first" ? ["shared"] : ["shared", "first-only"];
  const claimed = expect.objectContaining({ kind: "claimed" });
  const duplicate = { kind: "duplicate" };
  expect([await guard.claimKeys(...sharedKeys), await guard.claimKeys("second-only")]).toEqual(
    failed === "first" ? [claimed, duplicate] : [duplicate, claimed],
  );
});

it.each([
  { errorMode: "release" as const, nextKind: "claimed" },
  { errorMode: "commit" as const, nextKind: "duplicate" },
])("uses $errorMode error settlement in processGuarded", async ({ errorMode, nextKind }) => {
  const guard = createGuard();
  const event = { accountId: "work", keys: [`message-${errorMode}`] };

  const error = new Error("handler failed");
  await expect(
    guard.processGuarded(event, () => Promise.reject(error), { onError: errorMode }),
  ).rejects.toBe(error);
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
