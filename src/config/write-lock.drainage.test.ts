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
import {
  composeConfigWriteAssertions,
  createConfigWriteAuthorityGuard,
} from "./write-authority.js";
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
const lock = <T>(run: () => Promise<T>, guard?: () => void, filename = configPath) =>
  withConfigWriteLock(filename, run, undefined, guard);

function retainedCustody() {
  const store = createManagedHandoffLeaseStore();
  const installRoot = path.join(fixture.root, "install");
  fs.mkdirSync(installRoot);
  const parent = store.acquire(installRoot, "run", { kind: "update" });
  if (parent.kind !== "acquired") {
    throw new Error("fixture parent unavailable");
  }
  const database = path.join(fixture.root, "managed-update-handoffs.sqlite");
  return {
    reserve: () =>
      seedRetainedBorrower(
        database,
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
      ),
    release: () => store.release(parent.lease),
    rows: () => {
      using db = new DatabaseSync(database, { readOnly: true });
      return JSON.stringify(db.prepare("SELECT * FROM managed_update_handoffs").all());
    },
  };
}

it.each([
  { name: "unguarded", guarded: false, outerFails: false, custody: false },
  { name: "outer failure", guarded: true, outerFails: true, custody: false },
  { name: "unresolved custody", guarded: false, outerFails: false, custody: true },
])(
  "preserves pending child failure during drainage: $name",
  async ({ guarded, outerFails, custody }) => {
    const entered = createDeferred();
    const returned = createDeferred();
    const finish = createDeferred();
    const childFailure = new Error("admitted config child failed during drainage");
    const outerFailure = new Error("outer config callback failed");
    const guard = guarded ? vi.fn() : undefined;
    const retained = custody ? retainedCustody() : undefined;
    const snapshot = () => ({ lock: sidecar(), rows: retained?.rows() });
    let before: ReturnType<typeof snapshot> | undefined;
    let childSettled = false;
    let ownerSettled = false;
    let captured: (() => void) | undefined;
    let child: ReturnType<typeof outcome> | undefined;
    const owner = outcome(
      lock(async () => {
        captured = captureConfigWriteLockGuard(configPath);
        child = outcome(
          lock(async () => {
            entered.resolve();
            await finish.promise;
            childSettled = true;
            throw childFailure;
          }),
        );
        await entered.promise;
        retained?.reserve();
        returned.resolve();
        if (outerFails) {
          throw outerFailure;
        }
        return "outer result";
      }, guard),
    ).finally(() => {
      ownerSettled = true;
    });
    try {
      await returned.promise;
      await setImmediate();
      expect({ childSettled, ownerSettled }).toEqual({ childSettled: false, ownerSettled: false });
      before = snapshot();
      captured?.();
      await setImmediate();
      expect(snapshot()).toEqual(before);
    } finally {
      finish.resolve();
    }
    const result = await owner;
    expect(await child).toEqual({ ok: false, error: childFailure });
    if (result.ok) {
      throw new Error("Outer config interval lost its pending child's failure");
    }
    expect(result.error).toBeInstanceOf(AggregateError);
    const failures = outerFails ? [outerFailure, childFailure] : [childFailure];
    expect(result.error).toMatchObject({
      name: "AggregateError",
      errors: custody
        ? [
            expect.objectContaining({ name: "AggregateError", errors: failures }),
            expect.objectContaining({ message: "Source resource has unresolved native custody." }),
          ]
        : failures,
    });
    if (guarded) {
      expect(captured).toThrow("no live source ownership");
    }
    if (retained) {
      expect(snapshot()).toEqual(before);
      expect(retained.release()).toBe(false);
    } else {
      expect(fs.existsSync(configPath + ".lock")).toBe(false);
      await expect(lock(async () => "next")).resolves.toBe("next");
    }
  },
);

it("does not replay a nested failure reconciled before the outer callback returns", async () => {
  const failure = new Error("handled by caller");
  const result = await lock(async () => {
    const child = await outcome(
      lock(async () => {
        throw failure;
      }),
    );
    expect(child).toEqual({ ok: false, error: failure });
    return "reconciled";
  });
  expect(result).toBe("reconciled");
});

it("checks shared nested authority once per assertion and revalidates after awaits", async () => {
  const includePath = path.join(fixture.root, "include.json");
  fs.writeFileSync(includePath, "{}\n");
  const refusal = new Error("nested authority revoked");
  const authority = vi.fn<() => void>();
  let captured: (() => void) | undefined;
  await lock(async () => {
    await lock(
      async () => {
        captured = captureConfigWriteLockGuard(includePath);
        if (!captured) {
          throw new Error("Missing nested source guard");
        }
        authority.mockClear();
        for (const calls of [1, 2]) {
          captured();
          expect(authority).toHaveBeenCalledTimes(calls);
          await Promise.resolve();
        }
        authority.mockImplementation(() => {
          throw refusal;
        });
        expect(captured).toThrow(refusal);
        expect(authority).toHaveBeenCalledTimes(3);
      },
      authority,
      includePath,
    );
  }, authority);
  expect(captured).toThrow("Config write has no live source ownership for this path.");
  expect(authority).toHaveBeenCalledTimes(3);
});

it("retains ordered refusal latches when a composed authority was checked earlier", async () => {
  const events: string[] = [];
  const refusal = new Error("composed authority revoked");
  const original = () => events.push("original");
  const check = vi.fn(() => {
    events.push("retained");
  });
  const retained = createConfigWriteAuthorityGuard(check);
  const combined = composeConfigWriteAssertions(original, retained, original, () =>
    events.push("later"),
  );
  combined();
  expect(events).toEqual(["original", "retained", "later"]);
  await Promise.resolve();
  check.mockImplementationOnce(() => {
    throw refusal;
  });
  expect(retained).toThrow(refusal);
  events.length = 0;
  expect(combined).toThrow(refusal);
  expect(events).toEqual(["original"]);
});
