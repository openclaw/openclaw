import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireStateDatabaseSchemaLease } from "../../infra/gateway-state-owner.js";
import * as sqliteCheckpoint from "../../infra/sqlite-wal-checkpoint.js";
import type { SqliteWalHealth } from "../../infra/sqlite-wal-checkpoint.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import * as stateCache from "../../state/openclaw-state-db-cache.js";
import * as stateHandle from "../../state/openclaw-state-db-handle.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import * as stateWorkers from "../../state/openclaw-state-worker-store.js";
import * as statusSummary from "../../status/summary.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createRequestGatewayMethodRegistry, handleGatewayRequest } from "../server-methods.js";
import { GatewayRequestEntryLifetime } from "../server-request-entry.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./types.js";

const METHOD = "status.sqliteWal";

function forbidden(label: string) {
  return vi.fn(() => {
    throw new Error(`cached WAL request must not ${label}`);
  });
}

let state: OpenClawTestState;

beforeAll(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-cached-wal-boundary-" });
});

afterAll(async () => {
  await state.cleanup();
});

beforeEach(() => {
  resetGatewayWorkAdmission();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  resetGatewayWorkAdmission();
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.restoreAllMocks();
});

function fixture() {
  const read = vi.spyOn(stateCache, "readOpenClawStateWalHealth").mockReturnValue(undefined);
  const summary = vi
    .spyOn(statusSummary, "prepareStatusSummary")
    .mockImplementation(forbidden("build the general status summary"));
  const open = vi
    .spyOn(stateHandle, "openTrackedStateDatabase")
    .mockImplementation(forbidden("open a state database"));
  const checkpoint = vi
    .spyOn(sqliteCheckpoint, "createSqliteWalCheckpoint")
    .mockImplementation(forbidden("start a checkpoint"));
  const worker = vi
    .spyOn(stateWorkers, "runOpenClawStateWorkerOperation")
    .mockImplementation(forbidden("dispatch shared-state worker work"));
  const execute = vi
    .spyOn(stateWorkers, "executeOpenClawStateWorker")
    .mockImplementation(forbidden("execute shared-state worker work"));
  const lease = vi
    .spyOn(stateWorkers, "createOpenClawStateWorkerLease")
    .mockImplementation(forbidden("open a shared-state worker lease"));
  const projection = forbidden("prepare session rows");
  const desktop = forbidden("inspect the desktop");
  const refresh = forbidden("refresh health");
  const runtimeConfig = vi.fn(() => ({}));
  const requestEntryLifetime = new GatewayRequestEntryLifetime();
  const unavailableGatewayMethods = new Set<string>();
  // This request owns no session or task targets. Unrelated context capabilities
  // fail loudly instead of silently supplying working server/database fixtures.
  const context = {
    logGateway: { warn: vi.fn() },
    ensureSessionRowProjection: projection,
    hostDesktopService: { status: desktop },
    refreshHealthSnapshot: refresh,
    getRuntimeConfig: runtimeConfig,
    unavailableGatewayMethods,
    requestEntryLifetime,
  } as unknown as GatewayRequestContext;
  const methodRegistry = createRequestGatewayMethodRegistry();
  const respond = vi.fn<GatewayRequestOptions["respond"]>();
  const client = (scopes: string[], role: "operator" | "node" = "operator") => ({
    connId: "cached-wal-boundary",
    connect: gatewayConnect(scopes, { id: "cli", platform: "test", mode: "cli" }, 1, role),
  });
  const dispatch = (
    options: {
      scopes?: string[];
      role?: "operator" | "node";
      authenticated?: boolean;
      params?: Record<string, unknown>;
      signal?: AbortSignal;
    } = {},
  ) =>
    handleGatewayRequest({
      req: { type: "req", id: "cached-wal-read", method: METHOD, params: options.params ?? {} },
      client:
        options.authenticated === false
          ? null
          : client(options.scopes ?? ["operator.read"], options.role),
      respond,
      isWebchatConnect: () => false,
      context,
      methodRegistry,
      signal: options.signal,
    });
  const assertNoOtherWork = () => {
    for (const spy of [
      summary,
      open,
      checkpoint,
      projection,
      desktop,
      refresh,
      worker,
      execute,
      lease,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
  };
  return {
    read,
    respond,
    methodRegistry,
    unavailableGatewayMethods,
    requestEntryLifetime,
    dispatch,
    assertNoOtherWork,
  };
}

describe("cached WAL diagnostic through the canonical router", () => {
  it("routes the native owner's recorded health without SQLite work during dispatch", async () => {
    const custody = acquireStateDatabaseSchemaLease(resolveOpenClawStateSqlitePath());
    using _ = { [Symbol.dispose]: () => custody.release() };
    const owner = custody.run(() => openOpenClawStateDatabase());
    try {
      const native = requireNativeSqliteDatabase(owner.db);
      expect(custody.run(() => owner.walMaintenance.checkpoint())).toBe(true);
      const recorded = stateCache.readOpenClawStateWalHealth();
      expect(recorded).toMatchObject({ state: "complete", warning: false });
      const f = fixture();
      f.read.mockRestore();
      const read = vi.spyOn(stateCache, "readOpenClawStateWalHealth");
      const prepare = vi.spyOn(native, "prepare").mockImplementation(forbidden("prepare SQLite"));
      const exec = vi.spyOn(native, "exec").mockImplementation(forbidden("execute SQLite"));
      const checkpoint = vi
        .spyOn(owner.walMaintenance, "checkpoint")
        .mockImplementation(forbidden("checkpoint the existing native owner"));
      await f.dispatch();
      expect(read).toHaveBeenCalledExactlyOnceWith();
      expect(f.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          kind: "cached-sqlite-wal.v1",
          scope: "canonical-shared-cache",
          pid: process.pid,
          available: true,
          observation: recorded,
        }),
        undefined,
      );
      expect(prepare).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();
      f.assertNoOtherWork();
    } finally {
      // Preparation and owner retirement may use SQLite; only dispatch is read-only.
      vi.restoreAllMocks();
      await custody.run(() => stateCache.closeOpenClawStateDatabaseByPathAsync(owner.path));
    }
  });
  it.each(["operator.read", "operator.admin"])(
    "serves %s using only the cached getter",
    async (scope) => {
      const f = fixture();
      await f.dispatch({ scopes: [scope] });
      expect(f.read).toHaveBeenCalledExactlyOnceWith();
      expect(f.methodRegistry.getScope(METHOD)).toBe("operator.read");
      expect(f.methodRegistry.listAdvertisedMethods()).toContain(METHOD);
      expect(f.respond).toHaveBeenCalledExactlyOnceWith(
        true,
        {
          kind: "cached-sqlite-wal.v1",
          scope: "canonical-shared-cache",
          pid: process.pid,
          readAtMs: expect.any(Number),
          available: false,
          observation: null,
        },
        undefined,
      );
      f.assertNoOtherWork();
    },
  );

  it.each([{ authenticated: false }, { role: "node" as const }, { scopes: [] }])(
    "rejects an unauthorized request before cache access: %j",
    async (options) => {
      const f = fixture();
      await f.dispatch(options);
      expect(f.respond).toHaveBeenCalledTimes(1);
      expect(f.respond.mock.calls[0]?.[0]).toBe(false);
      expect(f.read).not.toHaveBeenCalled();
      f.assertNoOtherWork();
    },
  );

  it("honors startup unavailability before cache access", async () => {
    const f = fixture();
    f.unavailableGatewayMethods.add(METHOD);
    await f.dispatch();
    expect(f.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
      }),
    );
    expect(f.read).not.toHaveBeenCalled();
    f.assertNoOtherWork();
  });

  it.each(["restart", "suspension"] as const)("honors %s drain admission", async (reason) => {
    const f = fixture();
    if (reason === "restart") {
      markGatewayRestartDraining();
    } else {
      const admission = tryBeginGatewaySuspendAdmission(() => {});
      expect(admission).not.toBeNull();
      expect(admission?.drain()).toBe(true);
    }
    await f.dispatch();
    expect(f.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
      }),
    );
    expect(f.respond.mock.calls[0]?.[2]?.message).toContain(reason);
    expect(f.read).not.toHaveBeenCalled();
    f.assertNoOtherWork();
  });

  it("does not invoke the handler for an aborted request", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.dispatch({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.respond).not.toHaveBeenCalled();
    f.assertNoOtherWork();
  });

  it("does not invoke the handler after its preparation lifetime closes", async () => {
    const f = fixture();
    f.requestEntryLifetime.beginClose();
    await expect(f.dispatch()).rejects.toThrow("Gateway request entry is closed");
    expect(f.read).not.toHaveBeenCalled();
    expect(f.respond).not.toHaveBeenCalled();
    f.assertNoOtherWork();
  });

  it("rejects target-selection parameters without touching the getter", async () => {
    const f = fixture();
    await f.dispatch({ params: { path: "synthetic-forbidden-target" } });
    expect(f.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(f.read).not.toHaveBeenCalled();
    f.assertNoOtherWork();
  });

  it.each(["complete", "blocked", "error"] as const)(
    "preserves a cached %s observation",
    async (healthState) => {
      const f = fixture();
      const expected: SqliteWalHealth = {
        state: healthState,
        observedAtMs: 1,
        walBytes: 0,
        databaseBytes: null,
        logFrames: null,
        checkpointedFrames: 0,
        lastCompletedAtMs: null,
        consecutiveBlocked: 0,
        warning: healthState !== "complete",
      };
      const observation = { ...expected };
      const privateReads = ["error", "activeReaders", "readerDiagnostics"].map((name) => {
        const read = forbidden("read private WAL diagnostics");
        Object.defineProperty(observation, name, { enumerable: true, get: read });
        return read;
      });
      f.read.mockReturnValue(observation);
      await f.dispatch();
      expect(f.read).toHaveBeenCalledExactlyOnceWith();
      expect(f.respond.mock.calls[0]?.[1]).toMatchObject({
        available: true,
        observation: expected,
      });
      for (const read of privateReads) {
        expect(read).not.toHaveBeenCalled();
      }
      expect(f.respond.mock.calls[0]?.[1]).toHaveProperty("observation", expected);
      f.assertNoOtherWork();
    },
  );

  it("redacts a cached getter failure without trying a general status fallback", async () => {
    const f = fixture();
    f.read.mockImplementation(() => {
      throw new Error("synthetic private reader detail");
    });
    await f.dispatch();
    expect(f.read).toHaveBeenCalledExactlyOnceWith();
    expect(f.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: "cached WAL observation unavailable",
      }),
    );
    expect(JSON.stringify(f.respond.mock.calls)).not.toContain("synthetic private reader detail");
    f.assertNoOtherWork();
  });
});
