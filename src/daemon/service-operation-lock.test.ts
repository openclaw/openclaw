import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import { filterStringRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import { mergeGatewayServiceEnv } from "./service-env-merge.js";
import { buildServiceEnvironment } from "./service-env.js";
import {
  withGatewayServiceOperationLock,
  withSystemdServiceReadBinding,
} from "./service-operation-lock.js";
import type { GatewayServiceEnv, SystemdServiceReadBinding } from "./service-types.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

let env: { HOME: string; OPENCLAW_PROFILE: string };
let entered: ReturnType<typeof createDeferred<void>>;
let release: ReturnType<typeof createDeferred<void>>;
let binding: ReturnType<typeof readBinding>;
let create: ReturnType<typeof vi.fn<() => Promise<SystemdServiceReadBinding>>>;
beforeEach(async () => {
  const root = await fs.realpath(dirs.make("native-operation-"));
  const control = path.join(root, "control");
  await fs.mkdir(control, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  env = { HOME: root, OPENCLAW_PROFILE: path.basename(root).toLowerCase() };
  entered = createDeferred();
  release = createDeferred();
  binding = readBinding();
  create = vi.fn(async () => binding);
});

const lock = (operation: Parameters<typeof withGatewayServiceOperationLock>[1]) =>
  withGatewayServiceOperationLock(env, operation);
type Read = Parameters<typeof withSystemdServiceReadBinding>[2];
const read = (operation: Read, deadline?: number, readEnv: GatewayServiceEnv = env) =>
  withSystemdServiceReadBinding(readEnv, create, operation, deadline);
function suspend() {
  entered.resolve();
  return release.promise;
}

it("serializes independent native intervals while permitting their own nested operation", async () => {
  const events: string[] = [];
  const first = lock(async (assertCurrent) => {
    await suspend();
    assertCurrent();
    await lock(async (assertNested) => {
      assertNested();
      events.push("nested");
    });
    events.push("first");
  });
  await entered.promise;
  const second = lock(async () => events.push("second"));
  release.resolve();
  await Promise.all([first, second]);
  expect(events).toEqual(["nested", "first", "second"]);
});

it("joins an admitted detached effect and preserves failure", async () => {
  const failure = new Error("native effect failed after its caller returned");
  let assertRetired = () => undefined as void;
  const owner = lock(async (assertCurrent) => {
    assertRetired = assertCurrent;
    void lock(async () => {
      await suspend();
      throw failure;
    }).catch(() => undefined);
    await entered.promise;
  });
  const settled = owner.catch((error: unknown) => error);
  await entered.promise;
  // The caller has returned while the native effect still owns live work.
  await setImmediate();
  release.resolve();
  expect(await settled).toMatchObject({ errors: [failure] });
  expect(assertRetired).toThrow("ownership has closed");
  await lock(async (assertCurrent) => assertCurrent());
});

it("does not let a completed nested operation retain its parent's assertion", async () => {
  await lock(async (assertCurrent) => {
    let assertNested = () => undefined as void;
    await lock(async (assertOwned) => {
      assertNested = assertOwned;
      assertOwned();
    });
    assertCurrent();
    expect(assertNested).toThrow("ownership has closed");
  });
});

// Callers reconcile settled child failures; the lock owns only exclusion and drainage.
it("allows a caller to reconcile a nested failure before completing its interval", async () => {
  const failure = new Error("first native attempt failed");
  await lock(async (assertCurrent) => {
    await expect(lock(() => Promise.reject(failure))).rejects.toBe(failure);
    assertCurrent();
    await lock(async (assertNested) => assertNested());
  });
});

it("serializes the same systemd unit across alternate definition homes", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const first = lock(suspend);
  await entered.promise;
  const secondEntered = vi.fn(async () => {});
  const second = withGatewayServiceOperationLock(
    { ...env, HOME: path.join(env.HOME, "alternate") },
    secondEntered,
  );
  try {
    // A distinct lock would admit this native effect while the first remains live.
    await setTimeout(150);
    expect(secondEntered).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await Promise.all([first, second]);
  }
  expect(secondEntered).toHaveBeenCalledOnce();
});

const readBinding = () => ({
  unit: "openclaw-gateway.service",
  managerUid: 1000,
  destination: ":1.0",
  verify: vi.fn(),
  query: vi.fn(async () => []),
  close: vi.fn(async () => {}),
});

it.each([false, true])("retains nested reads: installed=%s", async (installed) => {
  if (installed) {
    env.OPENCLAW_PROFILE = "personal";
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  }
  const inspectionEnv = installed
    ? mergeGatewayServiceEnv(env, {
        programArguments: [process.execPath, "/opt/openclaw/openclaw.mjs", "gateway"],
        environment: filterStringRecord(
          buildServiceEnvironment({ env, port: 18789, platform: "linux" }),
        ),
      })
    : env;
  await lock(async () => {
    await read(async (first) => {
      expect(first).toBe(binding);
      await lock(async () =>
        read(async (nested) => expect(nested).toBe(first), undefined, inspectionEnv),
      );
      expect(binding.close).not.toHaveBeenCalled();
    });
    await read(async (second) => expect(second).toBe(binding), undefined, inspectionEnv);
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(binding.close).toHaveBeenCalledTimes(1);
});

it("joins pending reads before disposing their native binding", async () => {
  const owner = lock(async () => {
    void read(async () => {
      await suspend();
      expect(binding.close).not.toHaveBeenCalled();
    });
    await entered.promise;
  });
  await entered.promise;
  await setImmediate();
  expect(binding.close).not.toHaveBeenCalled();
  release.resolve();
  await owner;
  expect(binding.close).toHaveBeenCalledTimes(1);
});

it("closes standalone read bindings without acquiring a mutation interval", async () => {
  await expect(read(() => Promise.reject(new Error("read failed")))).rejects.toThrow("read failed");
  expect(binding.close).toHaveBeenCalledTimes(1);
});

it("expires a borrowing read without cancelling shared admission or running it later", async () => {
  const admission = createDeferred<typeof binding>();
  create.mockImplementation(() => admission.promise);
  const laterRead = vi.fn(async () => {});
  await lock(async () => {
    const original = read(async (value) => {
      expect(value).toBe(binding);
      expect(binding.close).not.toHaveBeenCalled();
    }, performance.now() + 2000);
    await expect(read(laterRead, performance.now() + 20)).rejects.toThrow(
      "admission deadline expired",
    );
    expect(laterRead).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(binding.close).not.toHaveBeenCalled();
    admission.resolve(binding);
    await original;
    expect(laterRead).not.toHaveBeenCalled();
  });
  expect(binding.close).toHaveBeenCalledOnce();
});
