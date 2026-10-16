import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import { authorizeOperatorScopesForMethod } from "../gateway/method-scopes.js";
import { createDirectChatContext } from "../gateway/server-chat.agent-events.test-helpers.js";
import { backupHandlers } from "../gateway/server-methods/backup.js";
import type { RespondFn } from "../gateway/server-methods/types.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../infra/gateway-lock.js";
import * as stateOwner from "../infra/gateway-state-owner.js";
import { readBackupRuns } from "../state/backup-run-records.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { backupRecordCommand } from "./backup-record.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const transport = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: transport.call,
}));

let lock: GatewayLockHandle | null = null;
const roots = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await lock?.release();
    lock = null;
    resetConfigRuntimeState();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    transport.call.mockReset();
    cleanup();
  }),
);

async function fixture(bootstrap = true) {
  const root = roots.make("openclaw-backup-owner-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  if (bootstrap) {
    await fs.writeFile(path.join(root, "openclaw.json"), "{}");
    runOpenClawStateWriteTransaction(() => undefined);
  }
  return { root, databasePath: resolveOpenClawStateSqlitePath() };
}

async function receive(params: Record<string, unknown>, authority = true) {
  const respond = vi.fn<RespondFn>();
  const config = {};
  await backupHandlers["backup.recordOutcome"]!({
    req: { type: "req", id: "outcome", method: "backup.recordOutcome" },
    params,
    context: createDirectChatContext({ getRuntimeConfig: () => config }),
    client: null,
    isWebchatConnect: () => false,
    hasCurrentClientAuthority: () => authority,
    respond,
  });
  return respond;
}

describe("backup outcome ownership", () => {
  it("records offline under exclusive custody and leaves an absent database absent", async () => {
    const { databasePath } = await fixture(false);
    const runtime = createTestRuntime();
    await backupRecordCommand(runtime, { status: "ok", target: "missing", json: true });
    await expect(fs.access(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    runOpenClawStateWriteTransaction(() => undefined);
    await backupRecordCommand(runtime, { status: "ok", target: "offline", json: true });
    expect(await readBackupRuns(process.env)).toMatchObject([{ target: "offline", status: "ok" }]);
    expect(stateOwner.captureGatewayStateOwner(databasePath)).toBeUndefined();
    expect(transport.call).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "routes to the live writer, publishes its next read, and never replays a lost reply (%s)",
    async (loseReply) => {
      const { databasePath } = await fixture();
      lock = await acquireGatewayLock({ allowInTests: true, port: 18789 });
      const owner = stateOwner.captureGatewayStateOwner(databasePath)!;
      expect(await readBackupRuns(process.env)).toEqual([]);
      // Model a CLI process without hiding the real lock or the Gateway's owner guard.
      vi.spyOn(stateOwner, "captureGatewayStateOwner").mockReturnValueOnce(undefined);
      transport.call.mockImplementation(async (options: CallGatewayOptions) => {
        expect(options.method).toBe("backup.recordOutcome");
        expect(options.params).toMatchObject({ expectedOwnerId: owner.ownerId });
        await options.prepareDispatchCurrent?.();
        options.assertDispatchCurrent?.();
        const response = await receive(options.params as Record<string, unknown>);
        expect(response).toHaveBeenCalledWith(true, { recorded: true }, undefined);
        if (loseReply) {
          throw new Error("reply lost after commit");
        }
        return { recorded: true };
      });
      const runtime = createTestRuntime();
      await backupRecordCommand(runtime, { status: "ok", target: "host-restic", bytes: 42 });
      expect(transport.call).toHaveBeenCalledTimes(1);
      expect(await readBackupRuns(process.env)).toMatchObject([
        { target: "host-restic", status: "ok", bytes: 42 },
      ]);
      expect(await readBackupRuns(process.env)).toHaveLength(1);
      if (loseReply) {
        expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("No local fallback"));
      } else {
        expect(runtime.error).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects wrong owners, revoked callers, and malformed input before recording", async () => {
    const { databasePath } = await fixture();
    lock = await acquireGatewayLock({ allowInTests: true, port: 18789 });
    const expectedOwnerId = stateOwner.captureGatewayStateOwner(databasePath)!.ownerId;
    const outcome = { kind: "external", archivePath: "test", status: "ok", createdAt: 1 };
    for (const [params, authority] of [
      [{ expectedOwnerId: "replaced-owner", outcome }, true],
      [{ expectedOwnerId, outcome }, false],
    ] as const) {
      expect(await receive(params, authority)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          details: { reason: "STATE_OWNER_CHANGED", mutationAccepted: false },
        }),
      );
    }
    expect(
      await receive({ expectedOwnerId, outcome: { ...outcome, env: {} } }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(await readBackupRuns(process.env)).toEqual([]);
    expect(authorizeOperatorScopesForMethod("backup.recordOutcome", ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
  });

  it("leaves database bytes unchanged when the live owner refuses the routed outcome", async () => {
    const { databasePath } = await fixture();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    lock = await acquireGatewayLock({ allowInTests: true, port: 18789 });
    const before = await fs.readFile(databasePath);
    vi.spyOn(stateOwner, "captureGatewayStateOwner").mockReturnValueOnce(undefined);
    transport.call.mockImplementation(async (options: CallGatewayOptions) => {
      await options.prepareDispatchCurrent?.();
      options.assertDispatchCurrent?.();
      const response = await receive(options.params as Record<string, unknown>, false);
      expect(response).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          details: { reason: "STATE_OWNER_CHANGED", mutationAccepted: false },
        }),
      );
      throw Object.assign(new Error("Owner refused the outcome"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
        retryable: false,
        details: { reason: "STATE_OWNER_CHANGED", mutationAccepted: false },
      });
    });
    const runtime = createTestRuntime();
    await backupRecordCommand(runtime, { status: "ok", target: "refused" });
    expect(transport.call).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("No local mutation"));
    expect(await fs.readFile(databasePath)).toEqual(before);
    expect(await readBackupRuns(process.env)).toEqual([]);
  });
});
