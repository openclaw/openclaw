import { hkdfSync } from "node:crypto";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  loadChatRequestIdentityKeyAsync,
  loadDeviceIdentityIfPresentAsync,
  loadOrCreateDeviceIdentityAsync,
  loadOrCreateProcessDeviceIdentityAsync,
} from "./device-identity-async.js";
import type { DeviceIdentity, DeviceIdentityStoreOptions } from "./device-identity-store.js";
import { ed25519PrivateKeyPemFromRaw } from "./ed25519-signature.js";

type IdentityCommand = {
  type: "deviceIdentity.load" | "deviceIdentity.read";
  input: { identityKey: string };
};
type IdentityScope = {
  execute(command: IdentityCommand): Promise<DeviceIdentity | null>;
};
type IdentityOperationOptions = {
  existingOnly?: boolean;
  preparation?: { type: "deviceIdentity"; identityKey: string };
};

const boundary = vi.hoisted(() => ({
  warn: vi.fn(),
  run: vi.fn<
    (
      context: OpenClawStateWorkerContext,
      operation: (scope: IdentityScope) => Promise<DeviceIdentity | null>,
      options?: IdentityOperationOptions,
    ) => Promise<DeviceIdentity | null | undefined>
  >(),
  legacyPaths: new Set<string>(),
  unexpectedNative: () => {
    throw new Error("Native storage is outside this pure async identity control");
  },
}));

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => ({
      ...actual.createSubsystemLogger(...args),
      warn: boundary.warn,
    }),
  };
});

// Retain pure path resolution without config/paths' process-wide path initialization.
vi.mock("../config/paths.js", async () => {
  const { resolveStateDir } = await import("../config/state-dir.js");
  return { resolveStateDir };
});
vi.mock("../state/openclaw-state-db.js", () => ({
  openOpenClawStateDatabase: boundary.unexpectedNative,
  runOpenClawStateWriteTransaction: boundary.unexpectedNative,
}));
// mock-isolation: This fixture proves worker routing without opening native SQLite.
vi.mock("../state/openclaw-state-db-readonly.js", () => ({
  withExistingOpenClawStateDatabaseReadOnly: boundary.unexpectedNative,
}));
vi.mock("../state/openclaw-state-db-cache.js", () => ({
  captureOpenClawStateDatabaseReadAdmission: (databasePath: string) => ({
    databasePath,
    identity: { key: `path:${databasePath}`, canonicalPath: databasePath },
    assertCurrent() {},
  }),
}));
vi.mock("../state/openclaw-state-db-async-lifecycle.js", () => ({
  getOpenClawDatabaseMaintenanceScope: () => undefined,
}));
vi.mock("./path-existence.js", () => ({
  pathMayExistSync: (pathname: string) => boundary.legacyPaths.has(pathname),
}));
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: boundary.run,
}));

const identity: DeviceIdentity = {
  deviceId: "synthetic-device",
  publicKeyPem: "synthetic-public-key",
  privateKeyPem: "synthetic-private-key",
};

function syntheticOptions(name: string): DeviceIdentityStoreOptions {
  return { env: { OPENCLAW_STATE_DIR: path.resolve("/synthetic", name) } };
}

beforeEach(() => {
  boundary.run.mockReset();
  boundary.legacyPaths.clear();
});

describe("async device identity boundary", () => {
  it("derives and caches a chat-only key from persisted raw Ed25519 bytes", async () => {
    const options = syntheticOptions("chat-request-key");
    const privateKey = Buffer.alloc(32, 7);
    boundary.run.mockImplementation(async (_context, operation, opening) => {
      expect(opening).toEqual({ existingOnly: true });
      return operation({
        execute: async (command) => {
          expect(command).toEqual({
            type: "deviceIdentity.read",
            input: { identityKey: "primary" },
          });
          return { ...identity, privateKeyPem: ed25519PrivateKeyPemFromRaw(privateKey) };
        },
      });
    });
    const key = await loadChatRequestIdentityKeyAsync(options);
    expect(key).toEqual(
      Buffer.from(
        hkdfSync("sha256", privateKey, "openclaw.device-identity", "openclaw.chat.request.v1", 32),
      ),
    );
    expect(key).not.toEqual(privateKey);
    expect(await loadChatRequestIdentityKeyAsync(options)).toBe(key);
    expect(boundary.run).toHaveBeenCalledOnce();
  });

  it("warns once for missing or unreadable chat identity without creating or caching a replacement", async () => {
    const options = syntheticOptions("unavailable-chat-request-key");
    boundary.run
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("synthetic identity read failure"))
      .mockResolvedValueOnce({
        ...identity,
        privateKeyPem: ed25519PrivateKeyPemFromRaw(Buffer.alloc(32, 8)),
      });
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(loadChatRequestIdentityKeyAsync(options)).resolves.toBeNull();
    }
    await expect(loadChatRequestIdentityKeyAsync(options)).resolves.toHaveLength(32);
    for (const call of boundary.run.mock.calls) {
      expect(call[2]).toEqual({ existingOnly: true });
    }
    expect(boundary.run).toHaveBeenCalledTimes(4);
    expect(boundary.warn).toHaveBeenCalledExactlyOnceWith(
      'Gateway device identity "primary" is missing or unreadable; chat.send will continue without a keyed request fingerprint.',
    );
  });

  it.each([
    { mode: "create", explicitPath: false },
    { mode: "read", explicitPath: true },
  ] as const)(
    "captures caller scope before delayed $mode dispatch (explicit path: $explicitPath)",
    async ({ mode, explicitPath }) => {
      const stateDir = path.resolve("/synthetic/captured-identity");
      const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_SUPERVISOR_MODE: "external" };
      const options: DeviceIdentityStoreOptions = { env, identityKey: "captured-key" };
      if (explicitPath) {
        options.path = path.resolve("/synthetic/explicit-identity/../captured.sqlite");
      }
      const databasePath = options.path ?? path.join(stateDir, "state", "openclaw.sqlite");
      const dispatch = createDeferredCore();
      const entered = createDeferredCore();
      const completion = createDeferredCore<DeviceIdentity>();
      boundary.run.mockImplementation(async (context, operation, opening) => {
        await dispatch.promise;
        expect(context.admission.databasePath).toBe(databasePath);
        expect(context.environment).toEqual({
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_SUPERVISOR_MODE: "external",
        });
        expect(opening).toEqual(
          mode === "create"
            ? { preparation: { type: "deviceIdentity", identityKey: "captured-key" } }
            : { existingOnly: true },
        );
        return await operation({
          execute: async (command) => {
            expect(command).toEqual({
              type: mode === "create" ? "deviceIdentity.load" : "deviceIdentity.read",
              input: { identityKey: "captured-key" },
            });
            entered.resolve();
            return await completion.promise;
          },
        });
      });
      const loading =
        mode === "create"
          ? loadOrCreateDeviceIdentityAsync(options)
          : loadDeviceIdentityIfPresentAsync(options);
      env.OPENCLAW_STATE_DIR = path.resolve("/synthetic/mutated");
      env.OPENCLAW_SUPERVISOR_MODE = "internal";
      options.path = path.resolve("/synthetic/replaced.sqlite");
      options.identityKey = "changed-key";
      options.env = { OPENCLAW_STATE_DIR: path.resolve("/synthetic/replaced") };
      dispatch.resolve();
      await Promise.race([entered.promise, loading]);
      await expect(Promise.race([loading, Promise.resolve("pending")])).resolves.toBe("pending");
      completion.resolve(identity);
      await expect(loading).resolves.toBe(identity);
    },
  );

  it.each([
    { result: undefined, suffix: undefined },
    { result: undefined, suffix: ".doctor-importing" },
    { result: null, suffix: "" },
  ])(
    "uses captured primary scope for an existing-only $result (legacy suffix: $suffix)",
    async ({ result, suffix }) => {
      const options = syntheticOptions("missing-identity");
      const stateDir = options.env!.OPENCLAW_STATE_DIR!;
      const legacyPath = path.join(stateDir, "identity", "device.json");
      if (suffix !== undefined) {
        boundary.legacyPaths.add(`${legacyPath}${suffix}`);
      }
      const opening = createDeferredCore();
      boundary.run.mockImplementation(async (_context, operation, admission) => {
        if (!admission?.existingOnly) {
          throw new Error("A missing identity read attempted to create shared state");
        }
        await opening.promise;
        return result === null ? operation({ execute: async () => null }) : undefined;
      });
      const loading = loadDeviceIdentityIfPresentAsync(options);
      const outcome =
        suffix === undefined || result === null
          ? expect(loading).resolves.toBeNull()
          : expect(loading).rejects.toThrow(`Legacy device identity exists at ${legacyPath}`);
      options.env!.OPENCLAW_STATE_DIR = path.resolve("/synthetic/changed-missing");
      options.path = path.resolve("/synthetic/changed-missing.sqlite");
      options.identityKey = "non-primary";
      opening.resolve();
      await outcome;
    },
  );

  it("converges concurrent process callers on one object and keeps keys independent", async () => {
    const options: DeviceIdentityStoreOptions = {
      ...syntheticOptions("process-identity-convergence"),
      identityKey: "first",
    };
    const capturedOptions = { ...options, env: { ...options.env } };
    const first = createDeferredCore<DeviceIdentity>();
    const second = createDeferredCore<DeviceIdentity>();
    boundary.run
      .mockImplementationOnce(async (_context, operation) =>
        operation({ execute: async () => first.promise }),
      )
      .mockImplementationOnce(async (_context, operation) =>
        operation({ execute: async () => second.promise }),
      );
    const firstLoad = loadOrCreateProcessDeviceIdentityAsync(options);
    const secondLoad = loadOrCreateProcessDeviceIdentityAsync(options);
    options.path = path.resolve("/synthetic/changed-process.sqlite");
    options.identityKey = "changed-key";
    options.env!.OPENCLAW_STATE_DIR = path.resolve("/synthetic/changed-process");
    const winner = { ...identity };
    second.resolve(winner);
    await expect(secondLoad).resolves.toBe(winner);
    first.resolve({ ...identity });
    await expect(firstLoad).resolves.toBe(winner);

    const other = { ...identity, deviceId: "synthetic-other-device" };
    boundary.run.mockImplementation(async (_context, operation) =>
      operation({ execute: async () => other }),
    );
    await expect(
      loadOrCreateProcessDeviceIdentityAsync({ ...capturedOptions, identityKey: "second" }),
    ).resolves.toBe(other);

    boundary.run.mockImplementation(async () => {
      throw new Error("The worker is unavailable after the process identities were cached");
    });
    await expect(loadOrCreateProcessDeviceIdentityAsync(capturedOptions)).resolves.toBe(winner);
    await expect(
      loadOrCreateProcessDeviceIdentityAsync({ ...capturedOptions, identityKey: "second" }),
    ).resolves.toBe(other);
  });
});
