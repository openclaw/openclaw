import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createManagedHandoffLeaseStore } from "../infra/update-managed-service-handoff-lease.js";
import { seedRetainedBorrower } from "../infra/update-retained-custody.test-support.js";
import { drainFileLockStateForTest, resetFileLockStateForTest } from "../plugin-sdk/file-lock.js";
import { captureConfigWriteLockGuard, withConfigWriteLock } from "./write-lock.js";

const fixture = vi.hoisted(() => ({
  root: "",
  nativeCalls: vi.fn(() => {
    throw new Error("Native execution forbidden in pure config drainage test");
  }),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: fixture.nativeCalls,
  spawnSync: fixture.nativeCalls,
  exec: fixture.nativeCalls,
  execSync: fixture.nativeCalls,
  execFile: fixture.nativeCalls,
  execFileSync: fixture.nativeCalls,
  fork: fixture.nativeCalls,
}));
vi.mock("../shared/pid-alive.js", async (original) => ({
  ...(await original<typeof import("../shared/pid-alive.js")>()),
  isPidDefinitelyDead: () => false,
  getFileLockProcessStartTime: () => 123,
}));
vi.mock("../infra/tmp-openclaw-dir.js", () => ({
  DEFAULT_POSIX_TMP_ROOT: "/tmp/openclaw",
  resolvePreferredOpenClawTmpDir: () => fixture.root,
}));

let configPath: string;
beforeEach(() => {
  fixture.nativeCalls.mockClear();
  fixture.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "config-drainage-pure-")));
  configPath = path.join(fixture.root, "config.json");
  fs.writeFileSync(configPath, "{}\n");
  resetFileLockStateForTest();
});
afterEach(async () => {
  await drainFileLockStateForTest();
  expect(fixture.nativeCalls).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

function sidecar() {
  const file = configPath + ".lock";
  const stat = fs.lstatSync(file);
  return { bytes: fs.readFileSync(file), dev: stat.dev, ino: stat.ino };
}
function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

it.each([
  { guarded: false, outerFails: false },
  { guarded: true, outerFails: false },
  { guarded: false, outerFails: true },
  { guarded: true, outerFails: true },
])(
  "preserves pending child failure (guarded=$guarded, outerFails=$outerFails)",
  async ({ guarded, outerFails }) => {
    const entered = createDeferred();
    const returned = createDeferred();
    const finish = createDeferred();
    const childFailure = new Error("admitted config child failed during drainage");
    const outerFailure = new Error("outer config callback failed");
    const guard = guarded ? vi.fn() : undefined;
    let childSettled = false;
    let ownerSettled = false;
    let captured: (() => void) | undefined;
    let child: ReturnType<typeof outcome> | undefined;
    const owner = outcome(
      withConfigWriteLock(
        configPath,
        async () => {
          captured = captureConfigWriteLockGuard(configPath);
          child = outcome(
            withConfigWriteLock(configPath, async () => {
              entered.resolve();
              await finish.promise;
              childSettled = true;
              throw childFailure;
            }),
          );
          await entered.promise;
          returned.resolve();
          if (outerFails) {
            throw outerFailure;
          }
          return "outer result";
        },
        undefined,
        guard,
      ),
    ).then((result) => {
      ownerSettled = true;
      return result;
    });
    try {
      await returned.promise;
      // The callback returned/threw, but its admitted child is still blocked.
      await setImmediate();
      expect(childSettled).toBe(false);
      expect(ownerSettled).toBe(false);
      const held = sidecar();
      captured?.();
      await setImmediate();
      expect(sidecar()).toEqual(held);
    } finally {
      finish.resolve();
    }
    const result = await owner;
    expect(await child).toEqual({ ok: false, error: childFailure });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Outer config interval lost its pending child's failure");
    }
    expect(result.error).toBeInstanceOf(AggregateError);
    expect(result.error).toMatchObject({
      errors: outerFails ? [outerFailure, childFailure] : [childFailure],
    });
    if (guarded) {
      expect(captured).toBeDefined();
      expect(captured).toThrow("no live source ownership");
    }
    expect(fs.existsSync(configPath + ".lock")).toBe(false);
    await expect(withConfigWriteLock(configPath, async () => "next")).resolves.toBe("next");
  },
);

it("does not replay a nested failure reconciled before the outer callback returns", async () => {
  const failure = new Error("handled by caller");
  const result = await withConfigWriteLock(configPath, async () => {
    const child = await outcome(
      withConfigWriteLock(configPath, async () => {
        throw failure;
      }),
    );
    expect(child).toEqual({ ok: false, error: failure });
    return "reconciled";
  });
  expect(result).toBe("reconciled");
});

it.each([new Error("outer only"), undefined])(
  "preserves an outer-only rejection without inventing child failure (%s)",
  async (failure) => {
    const result = await outcome(
      withConfigWriteLock(configPath, async () => {
        // oxlint-disable-next-line typescript/only-throw-error -- JavaScript callbacks may reject with undefined; preserve the exact reason.
        throw failure;
      }),
    );
    expect(result).toEqual({ ok: false, error: failure });
  },
);

it("joins a rejecting admitted child before refusing unresolved-custody release", async () => {
  const store = createManagedHandoffLeaseStore();
  const installRoot = path.join(fixture.root, "install");
  fs.mkdirSync(installRoot);
  const parent = store.acquire(installRoot, "run", { kind: "update" });
  if (parent.kind !== "acquired") {
    throw new Error("fixture parent unavailable");
  }
  const rows = () => {
    const db = new DatabaseSync(path.join(fixture.root, "managed-update-handoffs.sqlite"), {
      readOnly: true,
    });
    try {
      return JSON.stringify(db.prepare("SELECT * FROM managed_update_handoffs").all());
    } finally {
      db.close();
    }
  };
  const entered = createDeferred();
  const reserved = createDeferred();
  const finish = createDeferred();
  const failure = new Error("child failed but custody is unresolved");
  let childSettled = false;
  let ownerSettled = false;
  let child: ReturnType<typeof outcome> | undefined;
  const owner = outcome(
    withConfigWriteLock(configPath, async () => {
      child = outcome(
        withConfigWriteLock(configPath, async () => {
          entered.resolve();
          await finish.promise;
          childSettled = true;
          throw failure;
        }),
      );
      await entered.promise;
      seedRetainedBorrower(
        path.join(fixture.root, "managed-update-handoffs.sqlite"),
        parent.lease,
        {
          runId: "run",
          transactionId: "transaction",
          claimId: "claim",
          revision: 1,
          recordSha256: "a".repeat(64),
          lifetimeId: "lifetime",
          serviceKey: path.join(fixture.root, "service"),
          configPaths: [configPath],
        },
        "reserved",
      );
      reserved.resolve();
    }),
  ).then((result) => {
    ownerSettled = true;
    return result;
  });
  await reserved.promise;
  const beforeRows = rows();
  const beforeLock = sidecar();
  try {
    await setImmediate();
    expect(ownerSettled).toBe(false);
    expect(childSettled).toBe(false);
    expect(rows()).toBe(beforeRows);
    expect(sidecar()).toEqual(beforeLock);
  } finally {
    finish.resolve();
  }
  const result = await owner;
  expect(await child).toEqual({ ok: false, error: failure });
  expect(childSettled).toBe(true);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    // The shared file-lock release guard is authoritative; no new settlement.
    expect(result.error).toMatchObject({
      name: "AggregateError",
      errors: [
        expect.objectContaining({ name: "AggregateError", errors: [failure] }),
        expect.objectContaining({ message: "Source resource has unresolved native custody." }),
      ],
    });
  }
  expect(rows()).toBe(beforeRows);
  expect(sidecar()).toEqual(beforeLock);
  expect(store.release(parent.lease)).toBe(false);
});
