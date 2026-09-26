import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import { tryAcquireExclusiveSqliteCoordinator } from "./sqlite-coordinator.js";
import { captureCoordinatorDatabase } from "./sqlite-coordinator.test-support.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireStateDatabaseCoordinator,
  acquireStateDatabaseHandleExclusion,
  hasStateDatabaseSourceExclusion,
  prepareStateDatabaseSourceExclusion,
  resolveStateDatabaseCoordinatorPath,
  resolveStateLifecycleRuntimeDirectory,
  tryCreateGatewaySchemaFenceDelegate,
  tryCreateStateLifecycleDelegate,
  withStateDatabaseCoordinatorRuntimeDirectory,
  withStateSchemaFence,
} from "./state-database-coordinator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("state database coordinator", () => {
  it("does not resolve physical paths when no source exclusion is active", () => {
    const realpath = vi.spyOn(fsSync.realpathSync, "native");
    try {
      expect(hasStateDatabaseSourceExclusion("/synthetic/openclaw.sqlite")).toBe(false);
      expect(prepareStateDatabaseSourceExclusion("/synthetic/openclaw.sqlite")).toBeUndefined();
      expect(realpath).not.toHaveBeenCalled();
    } finally {
      realpath.mockRestore();
    }
  });

  it("retains final-reference cleanup without treating its rolled-back handle as ownership", () => {
    const root = tempDirs.make("openclaw-coordinator-reference-retry-");
    const params = { databasePath: path.join(root, "state.sqlite"), runtimeDirectory: root };
    const { result: first, database } = captureCoordinatorDatabase(() =>
      acquireGatewayLifecycleCoordinator(params),
    );
    const last = acquireGatewayLifecycleCoordinator(params);
    const close = vi.spyOn(database, "close").mockImplementationOnce(() => {
      throw new Error("Fixture native close remains open");
    });
    try {
      first.release();
      expect(first.closed).toBe(true);
      expect(close).not.toHaveBeenCalled();
      expect(() => last.release()).toThrow("failed to release gateway-lifecycle coordinator");
      expect(last.closed).toBe(false);
      expect(database.isOpen).toBe(true);
      expect(database.isTransaction).toBe(false);
      expect(() => acquireGatewayLifecycleCoordinator(params)).toThrow("cleanup is pending");
      expect(
        tryCreateGatewaySchemaFenceDelegate({ ...params, actorId: "pending" }),
      ).toBeUndefined();
      first.release();
      expect(close).toHaveBeenCalledTimes(1);
      last.release();
      expect(last.closed).toBe(true);
      expect(close).toHaveBeenCalledTimes(2);
      acquireGatewayLifecycleCoordinator(params).release();
    } finally {
      close.mockRestore();
      first.release();
      last.release();
    }
  });

  it("retains a Gateway worker fence until worker exit while sealing shutdown admission", async () => {
    const root = tempDirs.make("openclaw-gateway-worker-fence-");
    const params = {
      databasePath: path.join(root, "state", "openclaw.sqlite"),
      runtimeDirectory: path.join(root, "runtime"),
      actorId: "shared-state-test",
    };
    // An actor can open before Gateway startup without opening a coordinator on main.
    const realpath = vi.spyOn(fsSync.realpathSync, "native");
    try {
      expect(tryCreateGatewaySchemaFenceDelegate(params)).toBeUndefined();
      expect(tryCreateStateLifecycleDelegate(params)).toBeUndefined();
      expect(realpath).not.toHaveBeenCalled();
    } finally {
      realpath.mockRestore();
    }
    expect(fsSync.existsSync(params.runtimeDirectory)).toBe(false);
    expect(
      withStateSchemaFence(params, () => tryCreateGatewaySchemaFenceDelegate(params)),
    ).toBeUndefined();

    const gateway = acquireGatewayLifecycleCoordinator(params);
    const nestedGateway = acquireGatewayLifecycleCoordinator(params);
    const lifecyclePath = vi.spyOn(fsSync.realpathSync, "native");
    try {
      expect(tryCreateStateLifecycleDelegate(params)).toBeUndefined();
      expect(lifecyclePath).not.toHaveBeenCalled();
    } finally {
      lifecyclePath.mockRestore();
    }
    const delegation = tryCreateGatewaySchemaFenceDelegate(params);
    expect(delegation).toBeDefined();
    if (!delegation) {
      nestedGateway.release();
      gateway.release();
      throw new Error("Gateway did not retain its worker fence");
    }
    const worker = new Worker(
      new URL("./state-database-coordinator.worker.test-support.mjs", import.meta.url),
      {
        execArgv: [],
        workerData: {
          params,
          port: delegation.port,
          sourceLoaderUrl: import.meta.resolve("tsx/esm/api"),
          coordinatorUrl: new URL("./state-database-coordinator.ts", import.meta.url).href,
        },
        transferList: [delegation.port],
      },
    );
    const ask = async (message: string) => {
      const response = once(worker, "message");
      worker.postMessage(message, []);
      return (await response)[0];
    };
    try {
      expect(await once(worker, "message")).toEqual(["ready"]);
      expect(await ask("plain")).toEqual({ error: "StateSchemaMutationConflictError" });
      expect(await ask("delegated")).toEqual({ result: "schema admitted" });

      gateway.release();
      expect(await ask("delegated")).toEqual({ result: "schema admitted" });
      nestedGateway.release();
      expect(tryCreateGatewaySchemaFenceDelegate(params)).toBeUndefined();
      expect(await ask("delegated")).toEqual({ error: "StateSchemaMutationConflictError" });
      expect(tryAcquireExclusiveSqliteCoordinator(gateway.path)).toBeNull();

      const exited = once(worker, "exit");
      worker.postMessage("close", []);
      expect(await exited).toEqual([0]);
      // Port closure alone does not release broker-owned custody.
      expect(tryAcquireExclusiveSqliteCoordinator(gateway.path)).toBeNull();
      delegation.release();
      const next = tryAcquireExclusiveSqliteCoordinator(gateway.path);
      expect(next).not.toBeNull();
      next?.release();
    } finally {
      await worker.terminate();
      delegation.release();
      nestedGateway.release();
      gateway.release();
    }
  });

  it("uses the captured coordinator runtime directory across worker preparation", async () => {
    const root = tempDirs.make("openclaw-coordinator-runtime-scope-");
    const original = resolveStateLifecycleRuntimeDirectory();
    await withStateDatabaseCoordinatorRuntimeDirectory(root, async () => {
      await Promise.resolve();
      const params = {
        databasePath: path.join(root, "state", "openclaw.sqlite"),
      };
      const { result: coordinator, database } = captureCoordinatorDatabase(() =>
        acquireStateDatabaseCoordinator(params),
      );
      let delegation: ReturnType<typeof tryCreateStateLifecycleDelegate>;
      try {
        delegation = tryCreateStateLifecycleDelegate({ ...params, actorId: "state-worker" });
        expect(delegation).toBeDefined();
        expect(coordinator.path).toBe(
          resolveStateDatabaseCoordinatorPath({
            ...params,
            runtimeDirectory: root,
            uid: typeof process.getuid === "function" ? process.getuid() : undefined,
          }),
        );
      } finally {
        delegation?.release();
        coordinator.release();
        expect(database.isOpen).toBe(false);
      }
    });
    expect(resolveStateLifecycleRuntimeDirectory()).toBe(original);
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "bounds component path probes with explicit coordinator %s and existing database %s",
    (explicit, existing) => {
      const root = tempDirs.make("openclaw-state-coordinator-path-work-");
      const params = {
        databasePath: path.join(root, "state", "openclaw.sqlite"),
        runtimeDirectory: root,
        uid: typeof process.getuid === "function" ? process.getuid() : undefined,
        coordinatorPath: explicit ? path.join(root, "custom", "coordinator.sqlite") : undefined,
      };
      const nativeModeEnv = captureEnv(["FS_SAFE_NATIVE_MODE"]);
      // fs-safe's Bun realpath workaround bypasses node:fs spies until oven-sh/bun#42374.
      // Select its portable path so this probe-count assertion observes the realpath owner.
      if (process.versions.bun) {
        setTestEnvValue("FS_SAFE_NATIVE_MODE", "off");
      }
      const resolvePath = vi.spyOn(fsSync, "realpathSync");
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          params.databasePath = path.join(root, `state-${attempt}`, "openclaw.sqlite");
          if (existing) {
            fsSync.mkdirSync(path.dirname(params.databasePath));
            fsSync.writeFileSync(params.databasePath, "");
          }
          const expectedPath =
            params.coordinatorPath ?? resolveStateDatabaseCoordinatorPath(params);
          resolvePath.mockClear();
          const coordinator = acquireStateDatabaseCoordinator(params);
          try {
            expect(coordinator.path).toBe(expectedPath);
            expect(resolvePath).toHaveBeenCalledTimes(existing ? 0 : 1);
          } finally {
            coordinator.release();
          }
        }
      } finally {
        resolvePath.mockRestore();
        nativeModeEnv.restore();
      }
    },
  );

  it.each([false, true])(
    "preserves the shipped path identity with native failure %s",
    (failNative) => {
      const root = tempDirs.make("openclaw-coordinator-identity-");
      const target = path.join(root, "target");
      const alias = path.join(root, "alias");
      fsSync.mkdirSync(target);
      fsSync.writeFileSync(path.join(target, "state.sqlite"), "");
      fsSync.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
      const paths = [target, alias, path.join(alias, "missing")];
      if (process.platform === "win32") {
        paths.push(
          target.toUpperCase(),
          target.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()),
        );
      }
      const legacyPaths = paths.map((directory) => {
        const databasePath = path.join(directory, "state.sqlite");
        const canonical = resolvePathViaExistingAncestorSync(databasePath);
        return {
          databasePath,
          runtimeDirectory: directory,
          expected: path.join(
            resolvePathViaExistingAncestorSync(directory),
            "openclaw-state-locks-42",
            `state-lifecycle.${sha256HexPrefixCore(canonical, 8)}.lock.sqlite`,
          ),
        };
      });
      const native = failNative
        ? vi.spyOn(fsSync.realpathSync, "native").mockImplementation(() => {
            throw new Error("native path resolution unavailable");
          })
        : undefined;
      try {
        for (const { expected, ...params } of legacyPaths) {
          expect(resolveStateDatabaseCoordinatorPath({ ...params, uid: 42 })).toBe(expected);
        }
      } finally {
        native?.mockRestore();
      }
    },
  );

  it("resolves lifecycle paths after the current write authority callback", () => {
    const root = tempDirs.make("openclaw-state-coordinator-authority-path-");
    const params = {
      databasePath: path.join(root, "state", "openclaw.sqlite"),
      runtimeDirectory: path.join(root, "initial-runtime"),
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    };
    const nextRuntime = path.join(root, "next-runtime");
    const expectedPath = resolveStateDatabaseCoordinatorPath({
      ...params,
      runtimeDirectory: nextRuntime,
    });
    const exclusion = acquireStateDatabaseHandleExclusion(params);
    let changeRuntime = false;
    try {
      exclusion.runWithCanonicalWrites(
        () => {
          if (changeRuntime) {
            params.runtimeDirectory = nextRuntime;
          }
        },
        () => {
          changeRuntime = true;
          const coordinator = acquireStateDatabaseCoordinator(params);
          try {
            expect(coordinator.path).toBe(expectedPath);
          } finally {
            coordinator.release();
          }
        },
      );
    } finally {
      exclusion.release();
    }
  });

  it.each([
    ["state", acquireStateDatabaseCoordinator],
    ["Gateway", acquireGatewayLifecycleCoordinator],
  ] as const)(
    "reacquires an existing %s coordinator without filesystem changes",
    async (_, acquire) => {
      const root = tempDirs.make("openclaw-lifecycle-coordinator-noop-");
      const params = {
        databasePath: path.join(root, "state", "openclaw.sqlite"),
        runtimeDirectory: root,
      };
      const first = acquire(params);
      const coordinatorPath = first.path;
      first.release();
      const directory = path.dirname(coordinatorPath);
      const beforeDirectory = await fs.stat(directory, { bigint: true });
      const beforeFile = await fs.stat(coordinatorPath, { bigint: true });
      const next = acquire(params);
      try {
        expect(await fs.readdir(directory)).toEqual([path.basename(coordinatorPath)]);
        const afterDirectory = await fs.stat(directory, { bigint: true });
        const afterFile = await fs.stat(coordinatorPath, { bigint: true });
        for (const key of ["ino", "mode", "size", "mtimeNs", "ctimeNs"] as const) {
          expect(afterDirectory[key]).toBe(beforeDirectory[key]);
          expect(afterFile[key]).toBe(beforeFile[key]);
        }
      } finally {
        next.release();
      }
    },
  );

  it("allows the owning Gateway process to mutate its own schema", async () => {
    const root = tempDirs.make("openclaw-gateway-schema-owner-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const runtimeDirectory = path.join(root, "runtime");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const gateway = acquireGatewayLifecycleCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });
    try {
      expect(withStateSchemaFence({ databasePath, runtimeDirectory }, () => "mutated")).toBe(
        "mutated",
      );
    } finally {
      gateway.release();
    }
  });
});
