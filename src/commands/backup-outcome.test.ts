import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
import * as stateDb from "../state/openclaw-state-db.js";
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
    await stateDb.closeOpenClawStateDatabaseAsync();
    stateDb.closeOpenClawStateDatabaseForTest();
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
    stateDb.runOpenClawStateWriteTransaction(() => undefined);
  }
  return { databasePath: resolveOpenClawStateSqlitePath(), runtime: createTestRuntime() };
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

const ownerChanged = { reason: "STATE_OWNER_CHANGED", mutationAccepted: false };
const ownerChangedError = expect.objectContaining({ details: ownerChanged });
function expectOwnerChanged(response: Awaited<ReturnType<typeof receive>>) {
  expect(response).toHaveBeenCalledWith(false, undefined, ownerChangedError);
}

it("records offline under exclusive custody and leaves an absent database absent", async () => {
  const { databasePath, runtime } = await fixture(false);
  await backupRecordCommand(runtime, { status: "ok", target: "missing", json: true });
  await expect(fs.access(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  stateDb.runOpenClawStateWriteTransaction(() => undefined);
  await backupRecordCommand(runtime, { status: "ok", target: "offline", json: true });
  expect(await readBackupRuns(process.env)).toMatchObject([{ target: "offline", status: "ok" }]);
  expect(stateOwner.captureGatewayStateOwner(databasePath)).toBeUndefined();
  expect(transport.call).not.toHaveBeenCalled();
  expect(runtime.error).not.toHaveBeenCalled();
});

it.each(["accepted", "reply-lost", "refused"])(
  "routes to the live writer without replay or local mutation: %s",
  async (outcome) => {
    const { databasePath, runtime } = await fixture();
    if (outcome === "refused") {
      await stateDb.closeOpenClawStateDatabaseAsync();
      stateDb.closeOpenClawStateDatabaseForTest();
    }
    lock = await acquireGatewayLock({ allowInTests: true, port: 18789 });
    const owner = stateOwner.captureGatewayStateOwner(databasePath)!;
    const before = outcome === "refused" ? await fs.readFile(databasePath) : undefined;
    expect(await readBackupRuns(process.env)).toEqual([]);
    // Model a CLI process without hiding the real lock or the Gateway's owner guard.
    vi.spyOn(stateOwner, "captureGatewayStateOwner").mockReturnValueOnce(undefined);
    transport.call.mockImplementation(async (options: CallGatewayOptions) => {
      expect(options).toMatchObject({
        method: "backup.recordOutcome",
        params: { expectedOwnerId: owner.ownerId },
      });
      await options.prepareDispatchCurrent?.();
      options.assertDispatchCurrent?.();
      const response = await receive(
        options.params as Record<string, unknown>,
        outcome !== "refused",
      );
      if (outcome === "refused") {
        expectOwnerChanged(response);
        throw Object.assign(new Error("Owner refused the outcome"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
          retryable: false,
          details: ownerChanged,
        });
      }
      expect(response).toHaveBeenCalledWith(true, { recorded: true }, undefined);
      if (outcome === "reply-lost") {
        throw new Error("reply lost after commit");
      }
      return { recorded: true };
    });
    await backupRecordCommand(runtime, { status: "ok", target: "host-restic", bytes: 42 });
    expect(transport.call).toHaveBeenCalledTimes(1);
    if (outcome === "refused") {
      expect(await fs.readFile(databasePath)).toEqual(before);
      expect(await readBackupRuns(process.env)).toEqual([]);
    } else {
      expect(await readBackupRuns(process.env)).toEqual([
        expect.objectContaining({ target: "host-restic", status: "ok", bytes: 42 }),
      ]);
    }
    if (outcome === "accepted") {
      expect(runtime.error).not.toHaveBeenCalled();
    } else {
      const error = outcome === "refused" ? "No local mutation" : "No local fallback";
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(error));
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
    expectOwnerChanged(await receive(params, authority));
  }
  expect(await receive({ expectedOwnerId, outcome: { ...outcome, env: {} } })).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST" }),
  );
  expect(await readBackupRuns(process.env)).toEqual([]);
  expect(authorizeOperatorScopesForMethod("backup.recordOutcome", ["operator.write"])).toEqual({
    allowed: false,
    missingScope: "operator.admin",
  });
});
