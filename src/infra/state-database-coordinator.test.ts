import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireStateDatabaseCoordinator,
  acquireStateDatabaseHandleExclusion,
  resolveStateDatabaseCoordinatorPath,
  withStateSchemaFence,
} from "./state-database-coordinator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("state database coordinator", () => {
  it.each([false, true])(
    "bounds filesystem path probes per acquisition with explicit coordinator path %s",
    (explicit) => {
      const root = tempDirs.make("openclaw-state-coordinator-path-work-");
      const params = {
        databasePath: path.join(root, "state", "openclaw.sqlite"),
        runtimeDirectory: root,
        uid: typeof process.getuid === "function" ? process.getuid() : undefined,
        coordinatorPath: explicit ? path.join(root, "custom", "coordinator.sqlite") : undefined,
      };
      const resolvePath = vi.spyOn(fsSync, "realpathSync");
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          params.databasePath = path.join(root, `state-${attempt}`, "openclaw.sqlite");
          const expectedPath =
            params.coordinatorPath ?? resolveStateDatabaseCoordinatorPath(params);
          resolvePath.mockClear();
          const coordinator = acquireStateDatabaseCoordinator(params);
          try {
            expect(coordinator.path).toBe(expectedPath);
            expect(resolvePath).toHaveBeenCalledTimes(2);
          } finally {
            coordinator.release();
          }
        }
      } finally {
        resolvePath.mockRestore();
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

  it("reference-counts same-process owners", async () => {
    const root = tempDirs.make("openclaw-state-database-coordinator-");
    const databasePath = path.join(root, "selected-state", "state", "openclaw.sqlite");
    const runtimeDirectory = path.join(root, "runtime");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const first = acquireStateDatabaseCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });
    const nested = acquireStateDatabaseCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });

    first.release();
    nested.release();

    const next = acquireStateDatabaseCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });
    next.release();
  });

  it("keeps Gateway presence independent from short state operations", async () => {
    const root = tempDirs.make("openclaw-gateway-lifecycle-coordinator-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const runtimeDirectory = path.join(root, "runtime");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const gateway = acquireGatewayLifecycleCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });
    const state = acquireStateDatabaseCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });

    state.release();
    gateway.release();
  });

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
