import { hkdfSync } from "node:crypto";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateDatabaseOptions as DatabaseOptions } from "../state/openclaw-state-db-contract.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadReply,
} from "../state/openclaw-state-read.types.js";
import type { OpenClawStateWorkerContext as WorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperationOptions as OperationOptions } from "../state/openclaw-state-worker-contract.js";
import type { DomainScope } from "../state/openclaw-state-worker-store.types.js";
import {
  loadChatRequestIdentityKeyAsync as loadChatKey,
  loadDeviceIdentityIfPresentAsync as readIdentity,
  loadOrCreateDeviceIdentityAsync as createIdentity,
  loadOrCreateProcessDeviceIdentityAsync as processIdentity,
} from "./device-identity-async.js";
import type { DeviceIdentity, DeviceIdentityStoreOptions } from "./device-identity-store.js";
import { ed25519PrivateKeyPemFromRaw } from "./ed25519-signature.js";

type IdentityReadCommand = Extract<OpenClawStateReadCommand, { type: "deviceIdentity.read" }>;
type IdentityReadReply = Extract<OpenClawStateReadReply, { ok: true; type: "deviceIdentity.read" }>;
type IdentityOperation = (scope: DomainScope) => Promise<DeviceIdentity>;

const boundary = vi.hoisted(() => ({
  warn: vi.fn(),
  run: vi.fn<
    (
      context: WorkerContext,
      operation: IdentityOperation,
      options?: OperationOptions,
    ) => Promise<DeviceIdentity>
  >(),
  read: vi.fn<
    (
      options: DatabaseOptions,
      command: IdentityReadCommand,
    ) => Promise<IdentityReadReply | undefined>
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
  executeExistingOpenClawStateRead: boundary.read,
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

function readReply(value: DeviceIdentity | null): IdentityReadReply {
  return { ok: true, sourceAdmitted: true, type: "deviceIdentity.read", identity: value };
}

const keyedIdentity = (key: Buffer) => ({
  ...identity,
  privateKeyPem: ed25519PrivateKeyPemFromRaw(key),
});

function identityScope(result: DeviceIdentity | Promise<DeviceIdentity>): DomainScope {
  return { execute: vi.fn<DomainScope["execute"]>().mockReturnValue(Promise.resolve(result)) };
}

function syntheticOptions(name: string): DeviceIdentityStoreOptions {
  return { env: { OPENCLAW_STATE_DIR: path.resolve("/synthetic", name) } };
}

beforeEach(() => {
  boundary.run.mockReset();
  boundary.read.mockReset();
  boundary.legacyPaths.clear();
});

describe("async device identity boundary", () => {
  it("derives and caches a chat-only key from persisted raw Ed25519 bytes", async () => {
    const options = syntheticOptions("chat-request-key");
    const privateKey = Buffer.alloc(32, 7);
    boundary.read.mockImplementation(async (selected, command) => {
      expect(selected).toEqual({
        path: path.join(options.env!.OPENCLAW_STATE_DIR!, "state", "openclaw.sqlite"),
        env: options.env,
      });
      expect(command).toEqual({ type: "deviceIdentity.read", input: { identityKey: "primary" } });
      return readReply(keyedIdentity(privateKey));
    });
    const key = await loadChatKey(options);
    expect(key).toEqual(
      Buffer.from(
        hkdfSync("sha256", privateKey, "openclaw.device-identity", "openclaw.chat.request.v1", 32),
      ),
    );
    expect(key).not.toEqual(privateKey);
    expect(await loadChatKey(options)).toBe(key);
    expect(boundary.read).toHaveBeenCalledOnce();
    expect(boundary.run).not.toHaveBeenCalled();
  });

  it("warns once for missing or unreadable chat identity without creating or caching a replacement", async () => {
    const options = syntheticOptions("unavailable-chat-request-key");
    boundary.read
      .mockResolvedValueOnce(readReply(null))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("synthetic identity read failure"))
      .mockResolvedValueOnce(readReply(keyedIdentity(Buffer.alloc(32, 8))));
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(loadChatKey(options)).resolves.toBeNull();
    }
    await expect(loadChatKey(options)).resolves.toHaveLength(32);
    expect(boundary.read).toHaveBeenCalledTimes(4);
    expect(boundary.run).not.toHaveBeenCalled();
    expect(boundary.warn).toHaveBeenCalledExactlyOnceWith(
      'Gateway device identity "primary" is missing or unreadable; chat.send will continue without a keyed request fingerprint.',
    );
  });

  it.each(["create", "read"] as const)(
    "captures caller scope before delayed %s dispatch",
    async (mode) => {
      const stateDir = path.resolve("/synthetic/captured-identity");
      const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_SUPERVISOR_MODE: "external" };
      const options: DeviceIdentityStoreOptions = { env, identityKey: "captured-key" };
      if (mode === "read") {
        options.path = path.resolve("/synthetic/explicit-identity/../captured.sqlite");
      }
      const databasePath = options.path ?? path.join(stateDir, "state", "openclaw.sqlite");
      const dispatch = createDeferredCore();
      const entered = createDeferredCore();
      const completion = createDeferredCore<DeviceIdentity>();
      if (mode === "create") {
        boundary.run.mockImplementation(async (context, operation, opening) => {
          await dispatch.promise;
          expect(context.admission.databasePath).toBe(databasePath);
          expect(context.environment).toEqual({
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_SUPERVISOR_MODE: "external",
          });
          expect(opening).toEqual({
            preparation: { type: "deviceIdentity", identityKey: "captured-key" },
          });
          const scope = identityScope(completion.promise);
          const result = operation(scope);
          expect(scope.execute).toHaveBeenCalledExactlyOnceWith({
            type: "deviceIdentity.load",
            input: { identityKey: "captured-key" },
          });
          entered.resolve();
          return await result;
        });
      } else {
        boundary.read.mockImplementation(async (selected, command) => {
          // The read owner captures these arguments before its asynchronous preparation.
          expect(selected).toEqual({ path: databasePath, env });
          expect(command).toEqual({
            type: "deviceIdentity.read",
            input: { identityKey: "captured-key" },
          });
          await dispatch.promise;
          expect([selected.path, command.input.identityKey]).toEqual([
            databasePath,
            "captured-key",
          ]);
          entered.resolve();
          return readReply(await completion.promise);
        });
      }
      const loading = mode === "create" ? createIdentity(options) : readIdentity(options);
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
    { result: null, suffix: ".native-importing" },
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
      boundary.read.mockImplementation(async (selected, command) => {
        expect(selected.path).toBe(path.join(stateDir, "state", "openclaw.sqlite"));
        expect(command).toEqual({ type: "deviceIdentity.read", input: { identityKey: "primary" } });
        await opening.promise;
        return result === null ? readReply(null) : undefined;
      });
      const loading = readIdentity(options);
      const outcome =
        suffix === undefined
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
    const cached = (identityKey = "first") => processIdentity({ ...capturedOptions, identityKey });
    const first = createDeferredCore<DeviceIdentity>();
    const second = createDeferredCore<DeviceIdentity>();
    boundary.run
      .mockImplementationOnce(async (_context, operation) =>
        operation(identityScope(first.promise)),
      )
      .mockImplementationOnce(async (_context, operation) =>
        operation(identityScope(second.promise)),
      );
    const firstLoad = processIdentity(options);
    const secondLoad = processIdentity(options);
    options.path = path.resolve("/synthetic/changed-process.sqlite");
    options.identityKey = "changed-key";
    options.env!.OPENCLAW_STATE_DIR = path.resolve("/synthetic/changed-process");
    const winner = { ...identity };
    second.resolve(winner);
    await expect(secondLoad).resolves.toBe(winner);
    first.resolve({ ...identity });
    await expect(firstLoad).resolves.toBe(winner);

    const other = { ...identity, deviceId: "synthetic-other-device" };
    boundary.run.mockImplementation(async (_context, operation) => operation(identityScope(other)));
    await expect(cached("second")).resolves.toBe(other);

    boundary.run.mockImplementation(async () => {
      throw new Error("The worker is unavailable after the process identities were cached");
    });
    await expect(cached()).resolves.toBe(winner);
    await expect(cached("second")).resolves.toBe(other);
  });
});
