import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import {
  withGatewayServiceOperationLock,
  withSystemdServiceReadBinding,
} from "./service-operation-lock.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = await fs.realpath(dirs.make("native-operation-"));
  const control = path.join(root, "control");
  await fs.mkdir(control, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  return { HOME: root, OPENCLAW_PROFILE: path.basename(root).toLowerCase() };
}

it("serializes independent native intervals while permitting their own nested operation", async () => {
  const env = await fixture();
  const entered = createDeferred();
  const release = createDeferred();
  const events: string[] = [];
  const first = withGatewayServiceOperationLock(env, async (assertCurrent) => {
    entered.resolve();
    await release.promise;
    assertCurrent();
    await withGatewayServiceOperationLock(env, async (assertNested) => {
      assertNested();
      events.push("nested");
    });
    events.push("first");
  });
  await entered.promise;
  const second = withGatewayServiceOperationLock(env, async () => {
    events.push("second");
  });
  release.resolve();
  await Promise.all([first, second]);
  expect(events).toEqual(["nested", "first", "second"]);
});

it.each([false, true])(
  "joins an admitted detached effect and preserves failure=%s",
  async (fails) => {
    const env = await fixture();
    const entered = createDeferred();
    const release = createDeferred();
    const failure = new Error("native effect failed after its caller returned");
    let assertRetired = () => undefined as void;
    let completed = false;
    const owner = withGatewayServiceOperationLock(env, async (assertCurrent) => {
      assertRetired = assertCurrent;
      void withGatewayServiceOperationLock(env, async () => {
        entered.resolve();
        await release.promise;
        if (fails) {
          throw failure;
        }
        completed = true;
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
    expect(result.ok).toBe(!fails);
    if (fails) {
      expect(result.error).toMatchObject({ errors: [failure] });
    } else {
      expect(completed).toBe(true);
    }
    expect(assertRetired).toThrow("ownership has closed");
    await withGatewayServiceOperationLock(env, async (assertCurrent) => assertCurrent());
  },
);

it("does not let a completed nested operation retain its parent's assertion", async () => {
  const env = await fixture();
  await withGatewayServiceOperationLock(env, async (assertCurrent) => {
    let assertNested = () => undefined as void;
    await withGatewayServiceOperationLock(env, async (assertOwned) => {
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
  const env = await fixture();
  const failure = new Error("first native attempt failed");
  await withGatewayServiceOperationLock(env, async (assertCurrent) => {
    await expect(
      withGatewayServiceOperationLock(env, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    assertCurrent();
    await withGatewayServiceOperationLock(env, async (assertNested) => assertNested());
  });
});

it("serializes the same systemd unit across alternate definition homes", async () => {
  const env = await fixture();
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const entered = createDeferred();
  const release = createDeferred();
  const first = withGatewayServiceOperationLock(env, async () => {
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
  const env = await fixture();
  const binding = readBinding();
  const create = vi.fn(async () => binding);
  await withGatewayServiceOperationLock(env, async () => {
    await withSystemdServiceReadBinding(env, create, async (first) => {
      expect(first).toBe(binding);
      await withGatewayServiceOperationLock(env, async () => {
        await withSystemdServiceReadBinding(env, create, async (nested) =>
          expect(nested).toBe(first),
        );
      });
      expect(binding.close).not.toHaveBeenCalled();
    });
    await withSystemdServiceReadBinding(env, create, async (second) =>
      expect(second).toBe(binding),
    );
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(binding.close).toHaveBeenCalledTimes(1);
});

it("rejects a conflicting manager route instead of replacing an operation binding", async () => {
  const env = await fixture();
  const create = vi.fn(async () => readBinding());
  await withGatewayServiceOperationLock(env, async () => {
    await withSystemdServiceReadBinding(env, create, async () => {});
    await expect(
      withSystemdServiceReadBinding(
        { ...env, DBUS_SESSION_BUS_ADDRESS: "unix:path=/different" },
        create,
        async () => {},
      ),
    ).rejects.toThrow("different manager");
  });
  expect(create).toHaveBeenCalledTimes(1);
});

it("joins pending reads before disposing their native binding", async () => {
  const env = await fixture();
  const binding = readBinding();
  const entered = createDeferred();
  const release = createDeferred();
  const owner = withGatewayServiceOperationLock(env, async () => {
    void withSystemdServiceReadBinding(
      env,
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
  const env = await fixture();
  const binding = readBinding();
  await expect(
    withSystemdServiceReadBinding(
      env,
      async () => binding,
      async () => {
        throw new Error("read failed");
      },
    ),
  ).rejects.toThrow("read failed");
  expect(binding.close).toHaveBeenCalledTimes(1);
});

it("expires a borrowing read without cancelling shared admission or running it later", async () => {
  const env = await fixture();
  const binding = readBinding();
  const admission = createDeferred<typeof binding>();
  const create = vi.fn(() => admission.promise);
  const laterRead = vi.fn(async () => {});
  await withGatewayServiceOperationLock(env, async () => {
    const original = withSystemdServiceReadBinding(
      env,
      create,
      async (value) => {
        expect(value).toBe(binding);
        expect(binding.close).not.toHaveBeenCalled();
      },
      performance.now() + 2000,
    );
    await expect(
      withSystemdServiceReadBinding(env, create, laterRead, performance.now() + 20),
    ).rejects.toThrow("admission deadline expired");
    expect(laterRead).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(binding.close).not.toHaveBeenCalled();
    admission.resolve(binding);
    await original;
    expect(laterRead).not.toHaveBeenCalled();
  });
  expect(binding.close).toHaveBeenCalledOnce();
});
