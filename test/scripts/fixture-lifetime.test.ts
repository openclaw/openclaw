import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { createDeferred } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let owner: ReturnType<typeof createVitestResourceOwner>;
beforeEach(() => {
  // The tests deliberately retain claims, then join/dispose their own probes.
  // Model that namespace separately from the runner executing these assertions.
  const root = tempDirs.make("fixture-lifetime-owner-");
  owner = createVitestResourceOwner(root);
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, root);
  }
});
afterEach(() => vi.unstubAllEnvs());
const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

function expectInputs(root: string, retained: boolean, resourceOwner = owner) {
  expect(fs.existsSync(root)).toBe(retained);
  const claim = expect(() => resourceOwner.assertReleased());
  if (retained) {
    claim.toThrow("Unreleased Vitest resource claim");
  } else {
    claim.not.toThrow();
  }
}

function heldGate() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered: entered.promise,
    open: () => release.resolve(),
    wait: vi.fn(async () => {
      entered.resolve();
      await release.promise;
    }),
  };
}

it("releases inputs and claims after a native execFileSync ENOENT error", async () => {
  const lifetime = createFixtureLifetime();
  const root = lifetime.createTempDir("fixture-missing-command-");
  const error = await lifetime
    .run(async () => execFileSync(path.join(root, "absent-command"), [], { stdio: "pipe" }))
    .catch((cause: unknown) => cause);
  expect(error).toHaveProperty("code", "ENOENT");
  expect((error as { error?: unknown }).error ?? error).toBe(error);
  await lifetime.cleanup();
  expectInputs(root, false);
});

it("releases cyclic joined results without treating repeated objects as uncertainty", async () => {
  const lifetime = createFixtureLifetime();
  const root = lifetime.createTempDir("fixture-joined-cycle-");
  const result = new AggregateError([], "joined failures");
  result.errors.push(result, { cause: result }, { error: result, processTreeState: "terminated" });
  await lifetime.run(async () => result);
  await lifetime.cleanup();
  expectInputs(root, false);
});

it("registers fresh fixture work after clean release and module reset", async () => {
  const first = fixture.createTempDir("fixture-first-");
  await fixture.cleanup();
  expectInputs(first, false);
  vi.resetModules();
  const { createFixtureLifetime: createFreshLifetime } =
    await import("../helpers/fixture-lifetime.js");
  const nestedOwner = createVitestResourceOwner(tempDirs.make("fixture-explicit-owner-"));
  const fresh = createFreshLifetime(nestedOwner.root);
  for (const [lifetime, expectedOwner] of [
    [fixture, owner],
    [fresh, nestedOwner],
  ] as const) {
    const root = lifetime.createTempDir("fixture-fresh-");
    expect(path.dirname(root)).toBe(expectedOwner.root);
    expect(() => expectedOwner.assertReleased()).toThrow("Unreleased Vitest resource claim");
    await lifetime.cleanup();
    expectInputs(root, false, expectedOwner);
  }
});

it("cleans independent roots after a removal failure and retries the retained root", async () => {
  const lifetime = createFixtureLifetime();
  const first = lifetime.createTempDir("fixture-lifetime-busy-");
  const second = lifetime.createTempDir("fixture-lifetime-independent-");
  const failure = Object.assign(new Error("fixture directory busy"), { code: "EBUSY" });
  const remove = fs.rmSync;
  const removal = vi.spyOn(fs.promises, "rm").mockImplementation(async (root, options) => {
    if (root === first) {
      throw failure;
    }
    remove(root, options);
  });
  try {
    await expect(lifetime.cleanup()).rejects.toBe(failure);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(false);
    removal.mockRestore();
    await lifetime.cleanup();
    expectInputs(first, false);
  } finally {
    removal.mockRestore();
    for (const root of [first, second]) {
      remove(root, { recursive: true, force: true });
    }
  }
});

it("holds claims for work admitted during asynchronous fixture removal", async () => {
  const lifetime = createFixtureLifetime();
  const first = lifetime.createTempDir("fixture-removing-");
  const removing = heldGate();
  const removed = createDeferred();
  const allowWork = createDeferred();
  const remove = fs.promises.rm;
  const removal = vi.spyOn(fs.promises, "rm").mockImplementation(async (root, options) => {
    if (root === first) {
      await removing.wait();
    }
    await remove(root, options);
    if (root === first) {
      removed.resolve();
    }
  });
  let cleaned = false;
  const cleanup = lifetime.cleanup().then(() => {
    cleaned = true;
  });
  let work: Promise<void> | undefined;
  try {
    await removing.entered;
    const later = lifetime.createTempDir("fixture-admitted-during-removal-");
    work = lifetime.run(() => allowWork.promise);
    removing.open();
    await removed.promise;
    // Let the first removal's completion callbacks run while the later body is held.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(cleaned).toBe(false);
    expectInputs(later, true);
    allowWork.resolve();
    await work;
    await cleanup;
    expectInputs(later, false);
  } finally {
    removing.open();
    allowWork.resolve();
    await work;
    await cleanup;
    removal.mockRestore();
    await lifetime.cleanup();
  }
});
it("joins tracked cancellation and body unwind before releasing inputs", async () => {
  const root = fixture.createTempDir("fixture-lifetime-input-");
  const command = createDeferred<never>();
  const entered = createDeferred();
  const joined = createDeferred();
  const unwind = createDeferred();
  const cancelled = new Error("command cancelled after verified join");
  let laterPhase = false;
  const tracked = fixture.track(command.promise);
  const body = fixture.run(async () => {
    entered.resolve();
    try {
      await tracked;
      laterPhase = true;
    } finally {
      joined.resolve();
      await unwind.promise;
    }
  });
  const outcome = body.catch((error: unknown) => error);
  let cleaned = false;
  await entered.promise;
  const cleanup = fixture.cleanup();
  expect(fixture.cleanup()).toBe(cleanup);
  const settled = cleanup.then(() => {
    cleaned = true;
  });
  try {
    expectInputs(root, true);
    command.reject(cancelled);
    await joined.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(cleaned).toBe(false);
    expectInputs(root, true);
    unwind.resolve();
    expect(await outcome).toBe(cancelled);
    await settled;
    expectInputs(root, false);
    expect(laterPhase).toBe(false);
  } finally {
    command.reject(cancelled);
    unwind.resolve();
    await Promise.all([outcome, settled]);
  }
});

it.each(["cyclic aggregate", "cleanup"])(
  "retains inputs and reports unverified %s cleanup even when the body handled its rejection",
  async (kind) => {
    const root = fixture.createTempDir("fixture-lifetime-retained-");
    const uncertainty = Object.assign(new Error("group not joined"), {
      code: "EPROCESSGROUP_CLEANUP_FAILED",
      processTreeState: "indeterminate",
    });
    const aggregate = new AggregateError([], "sibling cleanup");
    aggregate.errors.push(
      aggregate,
      new Error("command failed", { cause: { error: uncertainty } }),
    );
    const error = kind === "cleanup" ? new Error("orphan verification failed") : aggregate;
    const run = kind === "cleanup" ? fixture.verifyCleanup : fixture.run;
    await expect(run(() => Promise.reject(error))).rejects.toBe(error);
    try {
      await expect(fixture.cleanup()).rejects.toThrow("Fixture cleanup unverified");
      expect(fs.existsSync(root)).toBe(true);
      await fixture.cleanup();
      const next = fixture.createTempDir("fixture-lifetime-reused-");
      await fixture.cleanup();
      expect(fs.existsSync(next)).toBe(false);
      expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
    } finally {
      // The injected uncertainty has no process behind it; this test owns its disposal.
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it("joins delayed acquisition and its cleanup before releasing fixture inputs", async () => {
  const lifetime = createFixtureLifetime(owner.root);
  const directory = lifetime.createTempDir("inputs-");
  const setup = heldGate();
  const cleanup = heldGate();
  let drained = false;
  const acquisition = lifetime.acquire(async () => {
    await setup.wait();
    return { cleanup: cleanup.wait };
  });
  const draining = lifetime.cleanup().then(() => {
    drained = true;
  });
  try {
    await setup.entered;
    expect(drained).toBe(false);
    await expect(fs.promises.stat(directory)).resolves.toBeDefined();
    expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
    setup.open();
    await acquisition;
    await cleanup.entered;
    expect(drained).toBe(false);
    await expect(fs.promises.stat(directory)).resolves.toBeDefined();
    cleanup.open();
    await draining;
    expect(cleanup.wait).toHaveBeenCalledTimes(1);
    await expect(fs.promises.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => owner.assertReleased()).not.toThrow();
  } finally {
    setup.open();
    cleanup.open();
    await Promise.allSettled([acquisition, draining]);
  }
});

it.each([
  { name: "error", cause: new Error("synthetic acquisition failed after allocating inputs") },
  { name: "undefined rejection", cause: undefined },
])("retains failed acquisition inputs and $name without a rollback receipt", async ({ cause }) => {
  const lifetime = createFixtureLifetime(owner.root);
  const directory = lifetime.createTempDir("inputs-");
  const rejected = createDeferred<never>();
  const acquisition = lifetime.acquire(() => rejected.promise);
  rejected.reject(cause);
  await expect(acquisition).rejects.toBe(cause);
  await expect(lifetime.cleanup()).rejects.toMatchObject({ errors: [cause] });
  await expect(fs.promises.stat(directory)).resolves.toBeDefined();
  expect(fs.existsSync(directory)).toBe(true);
  expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
});

it("joins explicit acquired cleanup once without repeating it during fallback teardown", async () => {
  const lifetime = createFixtureLifetime(owner.root);
  const cleanup = heldGate();
  const original = { cleanup: cleanup.wait };
  try {
    const acquired = await lifetime.acquire(async () => original);
    expect(acquired).toBe(original);
    const first = acquired.cleanup();
    const second = acquired.cleanup();
    expect(second).toBe(first);
    const draining = lifetime.cleanup();
    cleanup.open();
    await Promise.all([first, second, draining]);
    expect(cleanup.wait).toHaveBeenCalledTimes(1);
    expect(() => owner.assertReleased()).not.toThrow();
  } finally {
    cleanup.open();
    await lifetime.cleanup();
  }
});

it.each([
  { name: "error identity", cause: new Error("synthetic rolled-back acquisition") },
  { name: "undefined rejection", cause: undefined },
])("releases completed acquisition rollback while preserving $name", async ({ cause }) => {
  const lifetime = createFixtureLifetime(owner.root);
  const directory = lifetime.createTempDir("rolled-back-inputs-");
  const rollback = heldGate();
  const acquisition = lifetime.acquire((rejectAfterCleanup) =>
    rejectAfterCleanup(cause, async () => {
      await rollback.wait();
      await fs.promises.rm(directory, { recursive: true, force: true });
    }),
  );
  const rejected = expect(acquisition).rejects.toBe(cause);
  const draining = lifetime.cleanup();
  try {
    await rollback.entered;
    expectInputs(directory, true);
    rollback.open();
    await rejected;
    await draining;
    expectInputs(directory, false);
  } finally {
    rollback.open();
    await Promise.allSettled([acquisition, rejected, draining]);
  }
});

it("retains both errors and inputs when acquisition rollback fails", async () => {
  const lifetime = createFixtureLifetime(owner.root);
  const directory = lifetime.createTempDir("rollback-failed-inputs-");
  const original = new Error("synthetic acquisition failure");
  const rollback = new Error("synthetic rollback failure");
  await expect(
    lifetime.acquire((rejectAfterCleanup) =>
      rejectAfterCleanup(original, () => Promise.reject(rollback)),
    ),
  ).rejects.toMatchObject({ errors: [original, rollback], cause: rollback });
  await expect(lifetime.cleanup()).rejects.toMatchObject({
    errors: expect.arrayContaining([
      rollback,
      expect.objectContaining({ errors: [original, rollback] }),
    ]),
  });
  expectInputs(directory, true);
});
