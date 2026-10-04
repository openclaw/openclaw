import "../../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createSessionStoreSummaryReaderStub } from "../../config/sessions/session-store-summary.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../../cron/types.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";

let testConfig: OpenClawConfig = {};
let heartbeatJobs: CronJob[] = [];
let healthPluginsForTest: ChannelPlugin[] = [];
const tempDirs = createTempDirTracker();
let sessionStorePath: string;

let collectGatewayHealthSnapshot: typeof import("./collector.js").collectGatewayHealthSnapshot;
let createChannelTestPluginBase: typeof import("../../test-utils/channel-plugins.js").createChannelTestPluginBase;

function createHealthPlugin(): ChannelPlugin {
  const resolveAccount = (_cfg: OpenClawConfig, accountId?: string | null) => ({
    accountId: accountId?.trim() || "default",
    enabled: true,
    configured: true,
  });
  return {
    ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
    config: {
      listAccountIds: (cfg) => {
        const telegram = cfg.channels?.telegram as
          | { accounts?: Record<string, unknown> }
          | undefined;
        const accountIds = Object.keys(telegram?.accounts ?? {});
        return accountIds.length > 0 ? accountIds : ["default"];
      },
      resolveAccount,
      inspectAccount: resolveAccount,
      isEnabled: (account) => Boolean((account as { enabled?: boolean }).enabled),
      isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
    },
    status: {
      buildChannelSummary: ({ snapshot }) => ({
        accountId: snapshot.accountId,
        configured: snapshot.configured,
      }),
    },
  };
}

describe("collectGatewayHealthSnapshot legacy owner projection", () => {
  beforeAll(async () => {
    vi.doMock("../../infra/heartbeat-summary-snapshot.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../infra/heartbeat-summary-snapshot.js")>()),
      readHeartbeatSummarySnapshot: async () => heartbeatJobs,
    }));
    vi.doMock("../../config/config.js", () => ({
      getRuntimeConfig: () => testConfig,
    }));
    vi.doMock("../../config/sessions/paths.js", () => ({
      resolveSessionStorePathCore: () => sessionStorePath,
    }));
    vi.doMock("../../config/sessions/session-entry-read-runtime.js", () => ({
      withSessionStoreReaderInWorker: createSessionStoreSummaryReaderStub(),
    }));
    vi.doMock("../../channels/plugins/read-only.js", () => ({
      listReadOnlyChannelPluginsForConfig: () => healthPluginsForTest,
    }));

    const [health, channelTestUtils] = await Promise.all([
      import("./collector.js"),
      import("../../test-utils/channel-plugins.js"),
    ]);
    collectGatewayHealthSnapshot = health.collectGatewayHealthSnapshot;
    createChannelTestPluginBase = channelTestUtils.createChannelTestPluginBase;
  });

  beforeEach(() => {
    heartbeatJobs = [];
    sessionStorePath = path.join(
      tempDirs.make("openclaw-health-legacy-sessions-"),
      "sessions.json",
    );
    healthPluginsForTest = [createHealthPlugin()];
  });

  afterEach(() => {
    tempDirs.cleanup();
  });

  it("projects the Doctor-migrated owner without inventing an ownerless fleet default", async () => {
    const legacyConfig = {
      agents: {
        entries: { first: {}, ops: { default: true }, research: {} },
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram", accountId: "ops" } }],
      channels: {
        telegram: {
          accounts: {
            default: { botToken: "default-token" },
            ops: { botToken: "ops-token" },
          },
        },
      },
    };
    testConfig = createCanonicalAgentConfigFixture(legacyConfig).config;

    const migrated = await collectGatewayHealthSnapshot({ audience: "admin", probe: false });

    expect(migrated.defaultAgentId).toBe("ops");
    expect(migrated.agents.map(({ sessions }) => path.dirname(sessions.path))).toEqual(
      migrated.agents.map(() => path.dirname(sessionStorePath)),
    );
    const migratedOwner = migrated.agents.find((agent) => agent.isDefault);
    expect(migratedOwner?.agentId).toBe("ops");
    expect(migratedOwner?.heartbeat.enabled).toBe(false);
    expect(migrated.agents.find((agent) => agent.agentId === "first")?.heartbeat.enabled).toBe(
      false,
    );
    expect(migrated.heartbeatSeconds).toBe((migratedOwner?.heartbeat.everyMs ?? 0) / 1000);
    expect(migrated.channels.telegram?.accountId).toBe("ops");

    testConfig = {
      agents: {
        ownership: "explicit",
        entries: { first: {}, ops: {}, research: {} },
      },
    };

    const explicit = await collectGatewayHealthSnapshot({ audience: "admin", probe: false });

    expect(explicit.defaultAgentId).toBeUndefined();
    expect(explicit.agents.every((agent) => !agent.isDefault)).toBe(true);
    expect(explicit.agents.every((agent) => !agent.heartbeat.enabled)).toBe(true);
    expect(explicit.heartbeatSeconds).toBe(0);
  });

  it("projects converted automation cadence independently of the default agent", async () => {
    testConfig = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      },
    };
    heartbeatJobs = [createConvertedJob("research", true, 300_000)];

    const health = await collectGatewayHealthSnapshot({ audience: "admin", probe: false });

    expect(health.agents.map((agent) => agent.agentId)).toEqual(["ops", "research"]);
    expect(health.agents.find((agent) => agent.agentId === "research")?.heartbeat.enabled).toBe(
      true,
    );
    expect(health.heartbeatSeconds).toBe(300);
  });

  it("reports the active converted automation when an earlier job is disabled", async () => {
    testConfig = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      },
    };
    heartbeatJobs = [
      createConvertedJob("ops", false, 1_800_000),
      createConvertedJob("research", true, 3_600_000),
    ];

    const health = await collectGatewayHealthSnapshot({ audience: "admin", probe: false });

    expect(health.agents.map((agent) => agent.heartbeat.enabled)).toEqual([false, true]);
    expect(health.heartbeatSeconds).toBe(3_600);
  });
});

function createConvertedJob(agentId: string, enabled: boolean, everyMs: number): CronJob {
  return {
    id: `converted-${agentId}`,
    agentId,
    name: "Converted automation",
    enabled,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs },
    payload: { kind: "agentTurn", message: "Check for updates" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    state: {},
  };
}
