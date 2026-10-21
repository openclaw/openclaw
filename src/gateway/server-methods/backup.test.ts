import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
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
  const offsite = {
    provider: "filesystem" as const,
    settings: { path: "/missing/remote" },
    encryption: "none" as const,
  };
  const context = createDirectChatContext({
    cron,
    getRuntimeConfig: () => ({ storage: { locations: { offsite } } }),
  });
  const respond = vi.fn<RespondFn>();
  const handler = expectDefined(coreGatewayHandlers["backup.status"], "backup.status handler");
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

it("backup.status returns destination freshness, cron-owned schedules and config-only storage", async () => {
  const history = (archivePath: string, extra: Partial<BackupRunRecord> = {}) => {
    const latestOk: BackupRunRecord = {
      id: `${archivePath}:ok`,
      archivePath,
      createdAt: 10,
      kind: "archive",
      status: "ok",
      ...extra,
    };
    const latest: BackupRunRecord = {
      ...latestOk,
      id: `${archivePath}:failed`,
      createdAt: 20,
      status: "failed",
      archivePath: archivePath.replace("old", "new"),
    };
    return { latest, latestOk };
  };
  const offsite = history("", { target: "offsite", namespace: "host", bytes: 12 });
  offsite.latest.error = "disk unavailable";
  const targets = [
    { kind: "archive", target: "offsite", namespace: "host", ...offsite },
    { kind: "archive", target: "/new.tar", ...history("/old.tar") },
    {
      kind: "sqlite-snapshot",
      target: "/new-db",
      ...history("/old-db", { kind: "sqlite-snapshot" }),
    },
  ];
  ledger.mockResolvedValue([
    ...targets.map(({ latest }) => latest),
    ...targets.map(({ latestOk }) => latestOk),
  ]);
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
      targets,
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

it("backup.status requires read scope and rejects unsupported parameters before reading", async () => {
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
