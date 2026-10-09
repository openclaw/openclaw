import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBackupScheduleJob } from "../../cron/backup-command.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import type { CronJob } from "../../cron/types.js";
import type { BackupRunRecord } from "../../state/backup-run-records.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { RespondFn } from "./types.js";

const ledger = vi.hoisted(() => vi.fn<() => Promise<BackupRunRecord[]>>());
vi.mock("../../state/backup-run-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/backup-run-records.js")>()),
  readBackupRuns: ledger,
}));
vi.mock("../../plugins/active-runtime-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/active-runtime-registry.js")>()),
  getLoadedRuntimePluginRegistry: () => undefined,
}));
afterEach(() => {
  vi.restoreAllMocks();
  ledger.mockReset();
});

async function invoke(params: Record<string, unknown>, jobs: CronJob[] = []) {
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath: "/unused/backup-rpc/jobs.json",
    cronEnabled: false,
    defaultAgentId: "main",
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  vi.spyOn(cron, "list").mockResolvedValue(jobs);
  const context = createDirectChatContext({
    cron,
    getRuntimeConfig: () => ({
      storage: {
        locations: {
          offsite: {
            provider: "filesystem",
            settings: { path: "/missing/remote" },
            encryption: "none",
          },
        },
      },
    }),
  });
  const respond = vi.fn<RespondFn>();
  const handler = coreGatewayHandlers["backup.status"];
  if (!handler) {
    throw new Error("Missing backup.status handler");
  }
  await handler({
    req: { type: "req", id: "backup", method: "backup.status" },
    params,
    context,
    client: null,
    isWebchatConnect: () => false,
    respond,
  });
  return respond;
}

describe("backup.status", () => {
  it("returns destination freshness, cron-owned schedules and a config-only storage view", async () => {
    const ok: BackupRunRecord = {
      id: "ok",
      createdAt: 10,
      archivePath: "",
      kind: "archive",
      status: "ok",
      target: "offsite",
      namespace: "host",
      bytes: 12,
    };
    const failed: BackupRunRecord = {
      ...ok,
      id: "failed",
      createdAt: 20,
      status: "failed",
      error: "disk unavailable",
    };
    const archiveOk: BackupRunRecord = {
      id: "archive-ok",
      createdAt: 10,
      archivePath: "/backups/old.tar.gz",
      kind: "archive",
      status: "ok",
    };
    const archiveFailed: BackupRunRecord = {
      ...archiveOk,
      id: "archive-failed",
      createdAt: 20,
      archivePath: "/backups/new.tar.gz",
      status: "failed",
    };
    const snapshotOk: BackupRunRecord = {
      ...archiveOk,
      id: "snapshot-ok",
      kind: "sqlite-snapshot",
      archivePath: "/backups/old-snapshot",
    };
    const snapshotFailed: BackupRunRecord = {
      ...snapshotOk,
      id: "snapshot-failed",
      createdAt: 20,
      archivePath: "/backups/new-snapshot",
      status: "failed",
    };
    ledger.mockResolvedValue([failed, archiveFailed, snapshotFailed, ok, archiveOk, snapshotOk]);
    const job: CronJob = {
      ...buildBackupScheduleJob({
        mode: "offsite",
        location: "offsite",
        namespace: "host",
        includeWorkspace: true,
        everyMs: 60_000,
      }),
      id: "backup-job",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      state: { nextRunAtMs: 70_000 },
    };
    const respond = await invoke({}, [job]);
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        targets: [
          { kind: "archive", target: "offsite", namespace: "host", latest: failed, latestOk: ok },
          {
            kind: "archive",
            target: "/backups/new.tar.gz",
            latest: archiveFailed,
            latestOk: archiveOk,
          },
          {
            kind: "sqlite-snapshot",
            target: "/backups/new-snapshot",
            latest: snapshotFailed,
            latestOk: snapshotOk,
          },
        ],
        schedules: [
          {
            id: "backup-job",
            mode: "offsite",
            target: "offsite",
            namespace: "host",
            enabled: true,
            everyMs: 60_000,
            nextRunAtMs: 70_000,
          },
        ],
        locations: [
          {
            name: "offsite",
            provider: "filesystem",
            displayTarget: "/missing/remote",
            encrypted: false,
          },
        ],
      },
      undefined,
    );
  });

  it("requires operator read scope and rejects unsupported parameters before reading", async () => {
    expect(authorizeOperatorScopesForMethod("backup.status", ["operator.read"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("backup.status", [])).toEqual({
      allowed: false,
      missingScope: "operator.read",
    });
    expect(await invoke({ unexpected: true })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(ledger).not.toHaveBeenCalled();
  });
});
