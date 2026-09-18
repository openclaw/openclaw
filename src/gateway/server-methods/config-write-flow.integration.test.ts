import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const restartMocks = vi.hoisted(() => ({
  scheduleGatewaySigusr1Restart: vi.fn(() => ({
    scheduled: true,
    delayMs: 1_000,
    coalesced: false,
  })),
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: restartMocks.scheduleGatewaySigusr1Restart,
}));

vi.mock("../../version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../version.js")>();
  return {
    ...actual,
    resolveRuntimeServiceCommit: () => "testcomm",
    resolveRuntimeServiceVersion: () => "testversion",
  };
});

import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { resolveGatewayConfigRestartWriteResult } from "./config-write-flow.js";

type GatewayRestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;

function readCurrentSentinelRow() {
  const { db } = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_sentinel")
      .select(["sentinel_key", "kind", "status", "payload_json"])
      .where("sentinel_key", "=", "current"),
  );
}

async function withStateDir(run: () => Promise<void>): Promise<void> {
  await withTestDir({ prefix: "openclaw-config-sentinel-" }, async (tempDir) => {
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, run);
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });
}

const ACTOR = {
  actor: "openclaw-control-ui",
  deviceId: "device-1",
  clientIp: "127.0.0.1",
  connId: "conn-1",
} as const;

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveGatewayConfigRestartWriteResult real persistence", () => {
  beforeEach(() => {
    restartMocks.scheduleGatewaySigusr1Restart.mockClear();
  });

  it("does not persist a restart sentinel row for a hot-applied write", async () => {
    await withStateDir(async () => {
      const result = await resolveGatewayConfigRestartWriteResult({
        requestParams: {},
        kind: "config-patch",
        mode: "config.patch",
        configPath: "/tmp/openclaw.json",
        changedPaths: ["agents.defaults.model"],
        previousConfig: { agents: { defaults: { model: "old-model" } } } as OpenClawConfig,
        nextConfig: { agents: { defaults: { model: "new-model" } } } as OpenClawConfig,
        actor: ACTOR,
      });

      expect(result.sentinelPersisted).toBe(false);
      expect(result.payload.doctorHint).toBeNull();
      expect(result.payload.stats?.requiresRestart).toBe(false);

      // Real DB: no sentinel row exists for a hot-applied write.
      const row = readCurrentSentinelRow();
      expect(row).toBeUndefined();
    });
  });

  it("persists a restart sentinel row for a restart-requiring write", async () => {
    await withStateDir(async () => {
      const result = await resolveGatewayConfigRestartWriteResult({
        requestParams: {},
        kind: "config-patch",
        mode: "config.patch",
        configPath: "/tmp/openclaw.json",
        changedPaths: ["gateway.port"],
        previousConfig: { gateway: { port: 4_000 } } as OpenClawConfig,
        nextConfig: { gateway: { port: 4_001 } } as OpenClawConfig,
        actor: ACTOR,
      });

      expect(result.sentinelPersisted).toBe(true);
      expect(result.payload.doctorHint).toContain("openclaw doctor --non-interactive");
      expect(result.payload.stats?.requiresRestart).toBe(true);

      // Real DB: a sentinel row exists for a restart-requiring write.
      const row = readCurrentSentinelRow();
      expect(row).toBeDefined();
      expect(row?.kind).toBe("config-patch");
      expect(row?.status).toBe("ok");
      const persistedPayload = JSON.parse(row?.payload_json ?? "{}");
      expect(persistedPayload.stats?.requiresRestart).toBe(true);
      expect(persistedPayload.doctorHint).toContain("openclaw doctor --non-interactive");
    });
  });
});
