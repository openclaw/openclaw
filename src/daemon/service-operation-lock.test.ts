import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
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
import type { SystemdServiceReadBinding } from "./service-types.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

let env: { HOME: string; OPENCLAW_PROFILE: string };
beforeEach(async () => {
  const root = await fs.realpath(dirs.make("native-operation-"));
  const control = path.join(root, "control");
  await fs.mkdir(control, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  env = { HOME: root, OPENCLAW_PROFILE: path.basename(root).toLowerCase() };
});

function lock<T>(operation: (assertCurrent: () => void) => Promise<T>) {
  return withGatewayServiceOperationLock(env, operation);
}
function read<T>(
  create: () => Promise<SystemdServiceReadBinding | undefined>,
  operation: (binding: SystemdServiceReadBinding | undefined) => Promise<T>,
  deadline?: number,
) {
  return withSystemdServiceReadBinding(env, create, operation, deadline);
}

it("serializes independent native intervals while permitting their own nested operation", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const events: string[] = [];
  const first = lock(async (assertCurrent) => {
    entered.resolve();
    await release.promise;
    assertCurrent();
    await lock(async (assertNested) => {
      assertNested();
      events.push("nested");
    });
    events.push("first");
  });
  await entered.promise;
  const second = lock(async () => {
    events.push("second");
  });
  release.resolve();
  await Promise.all([first, second]);
  expect(events).toEqual(["nested", "first", "second"]);
});

it("joins an admitted detached effect and preserves failure", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const failure = new Error("native effect failed after its caller returned");
  let assertRetired = () => undefined as void;
  const owner = lock(async (assertCurrent) => {
    assertRetired = assertCurrent;
    void lock(async () => {
      entered.resolve();
      await release.promise;
      throw failure;
    }).catch(() => undefined);
    await entered.promise;
  });
  const settled = owner.then(
    () => ({ ok: true, error: undefined }),
    (error: unknown) => ({ ok: false, error }),
  );
  await entered.promise;
  // The caller has returned while the native effect still owns live work.
  await setImmediate();
  release.resolve();
  const result = await settled;
  expect(result).toMatchObject({ ok: false, error: { errors: [failure] } });
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

// The caller owns reconciliation of a settled child failure; the lock owns
// exclusion and drainage, not a new all-or-nothing native transaction.
it("allows a caller to reconcile a nested failure before completing its interval", async () => {
  const failure = new Error("first native attempt failed");
  await lock(async (assertCurrent) => {
    await expect(
      lock(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    assertCurrent();
    await lock(async (assertNested) => assertNested());
  });
});

it("serializes the same systemd unit across alternate definition homes", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const entered = createDeferred();
  const release = createDeferred();
  const first = lock(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let secondEntered = false;
  const second = withGatewayServiceOperationLock(
    { ...env, HOME: path.join(env.HOME, "alternate") },
    async () => {
      secondEntered = true;
    },
  );
  try {
    // A distinct lock would admit this native effect while the first remains live.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150);
    });
    expect(secondEntered).toBe(false);
  } finally {
    release.resolve();
    await Promise.all([first, second]);
  }
  expect(secondEntered).toBe(true);
});

function readBinding() {
  return {
    unit: "openclaw-gateway.service",
    managerUid: 1000,
    destination: ":1.0",
    verify: vi.fn(),
    query: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  };
}

it("retains one read binding across nested operations and closes after the outer interval", async () => {
  const binding = readBinding();
  const create = vi.fn(async () => binding);
  await lock(async () => {
    await read(create, async (first) => {
      expect(first).toBe(binding);
      await lock(async () => {
        await read(create, async (nested) => expect(nested).toBe(first));
      });
      expect(binding.close).not.toHaveBeenCalled();
    });
    await read(create, async (second) => expect(second).toBe(binding));
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(binding.close).toHaveBeenCalledTimes(1);
});

it("reuses service inspection after loading the installed environment", async () => {
  env.OPENCLAW_PROFILE = "personal";
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const binding = readBinding();
  const create = vi.fn(async () => binding);
  const serviceEnv = mergeGatewayServiceEnv(env, {
    programArguments: [process.execPath, "/opt/openclaw/openclaw.mjs", "gateway"],
    environment: filterStringRecord(
      buildServiceEnvironment({ env, port: 18789, platform: "linux" }),
    ),
  });
  await lock(async () => {
    await read(create, async () => {});
    await withSystemdServiceReadBinding(serviceEnv, create, async (retained) => {
      expect(retained).toBe(binding);
    });
  });
  expect(create).toHaveBeenCalledOnce();
  expect(binding.close).toHaveBeenCalledOnce();
});

it("joins pending reads before disposing their native binding", async () => {
  const binding = readBinding();
  const entered = createDeferred();
  const release = createDeferred();
  const owner = lock(async () => {
    void read(
      async () => binding,
      async () => {
        entered.resolve();
        await release.promise;
        expect(binding.close).not.toHaveBeenCalled();
      },
    );
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
  const binding = readBinding();
  await expect(
    read(
      async () => binding,
      async () => {
        throw new Error("read failed");
      },
    ),
  ).rejects.toThrow("read failed");
  expect(binding.close).toHaveBeenCalledTimes(1);
});

it("expires a borrowing read without cancelling shared admission or running it later", async () => {
  const binding = readBinding();
  const admission = createDeferred<typeof binding>();
  const create = vi.fn(() => admission.promise);
  const laterRead = vi.fn(async () => {});
  await lock(async () => {
    const original = read(
      create,
      async (value) => {
        expect(value).toBe(binding);
        expect(binding.close).not.toHaveBeenCalled();
      },
      performance.now() + 2000,
    );
    await expect(read(create, laterRead, performance.now() + 20)).rejects.toThrow(
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
