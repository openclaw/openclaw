import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import { clearOpenClawStateDatabaseOpenFailure } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import {
  acquireGatewayStateOwner,
  captureGatewayStateOwnerAsync,
  GatewayStateOwnerContentionError,
  prepareStateDatabaseReadAccess,
} from "./gateway-state-owner.js";

async function withOwner(
  operation: (fixture: {
    databasePath: string;
    path: (...parts: string[]) => string;
    owner: ReturnType<typeof acquireGatewayStateOwner>;
    acquire: () => ReturnType<typeof acquireGatewayStateOwner>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "prepared-gateway-owner" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const acquire = () =>
      acquireGatewayStateOwner({
        databasePath: database.path,
        payload: {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          configPath: state.configPath,
          role: "gateway",
          processNamespace: readGatewayLockProcessNamespace(),
        },
      });
    const owner = acquire();
    try {
      await operation({ databasePath: database.path, path: state.path, owner, acquire });
    } finally {
      vi.restoreAllMocks();
      await closeOpenClawStateDatabaseAsync();
      owner.release();
    }
  });
}

it.skipIf(process.platform === "win32")(
  "retains admitted alias reads while a fresh native capture rejects retargeting",
  async () =>
    withOwner(async ({ databasePath, path }) => {
      const alias = path("alias.sqlite");
      const successor = path("successor.sqlite");
      fs.symlinkSync(databasePath, alias);
      fs.writeFileSync(successor, "unrelated synthetic file");
      const { admission } = captureOpenClawStateReadContext(alias);
      const read = await prepareStateDatabaseReadAccess(admission);
      expect(read).toBeDefined();
      fs.unlinkSync(alias);
      fs.symlinkSync(successor, alias);
      expect(() => read?.assertReadAllowed()).not.toThrow();
      const resolve = vi.spyOn(fs.promises, "realpath");
      await expect(prepareStateDatabaseReadAccess(admission)).resolves.toBeDefined();
      expect(resolve.mock.calls.length).toBe(0);
      await expect(captureGatewayStateOwnerAsync(admission)).rejects.toBeInstanceOf(
        GatewayStateOwnerContentionError,
      );
    }),
);

it.skipIf(process.platform === "win32")(
  "qualifies a formerly canonical path before fresh native custody",
  async () =>
    withOwner(async ({ databasePath, path }) => {
      const { admission } = captureOpenClawStateReadContext(databasePath);
      fs.renameSync(databasePath, path("original.sqlite"));
      const successor = path("successor.sqlite");
      fs.writeFileSync(successor, "unrelated synthetic file");
      fs.symlinkSync(successor, databasePath);
      await expect(captureGatewayStateOwnerAsync(admission)).rejects.toBeInstanceOf(
        GatewayStateOwnerContentionError,
      );
      await expect(prepareStateDatabaseReadAccess(admission)).rejects.toBeInstanceOf(
        GatewayStateOwnerContentionError,
      );
    }),
);

it.each([
  ["read preparation", prepareStateDatabaseReadAccess],
  ["native capture", captureGatewayStateOwnerAsync],
] as const)("does not adopt a replacement Gateway generation during %s", async (_label, prepare) =>
  withOwner(async ({ databasePath, owner, acquire }) => {
    const { admission } = captureOpenClawStateReadContext(databasePath);
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const resolve = fs.promises.realpath.bind(fs.promises);
    vi.spyOn(fs.promises, "realpath").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await resume.promise;
      return resolve(...args);
    });
    const result = prepare(admission);
    const refusal = expect(result).rejects.toThrow("no longer current");
    await entered.promise;
    owner.release();
    const successor = acquire();
    try {
      resume.resolve();
      await refusal;
      successor.assertCurrent();
    } finally {
      resume.resolve();
      successor.release();
    }
  }),
);

it.each([
  ["read preparation", prepareStateDatabaseReadAccess],
  ["native capture", captureGatewayStateOwnerAsync],
] as const)("keeps the original database admission through %s", async (_label, prepare) =>
  withOwner(async ({ databasePath }) => {
    const { admission } = captureOpenClawStateReadContext(databasePath);
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const resolve = fs.promises.realpath.bind(fs.promises);
    vi.spyOn(fs.promises, "realpath").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await resume.promise;
      return resolve(...args);
    });
    const refused = prepare(admission).then(
      () => false,
      isStateDatabaseReadAdmissionInvalidatedError,
    );
    await entered.promise;
    clearOpenClawStateDatabaseOpenFailure(databasePath);
    resume.resolve();
    expect(await refused).toBe(true);
  }),
);
