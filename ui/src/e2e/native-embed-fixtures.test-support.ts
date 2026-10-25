import type { Page } from "playwright";
import type { SecretsStoreListResult } from "../../../packages/gateway-protocol/src/index.js";
import type { ApprovalHistoryResult } from "../../../packages/gateway-protocol/src/schema/approvals.js";
import type { WebSearchStatusResult } from "../../../packages/gateway-protocol/src/schema/web-search.ts";
import type { DevicePairingList } from "../../../src/gateway/device-pairing-list.types.js";
import type {
  ChannelsPairingListResult,
  ChannelsStatusSnapshot,
  CronJobsListResult,
} from "../api/types.ts";
import type { CommandLaneDiagnostics } from "../lib/gateway-diagnostics.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createNativeDeviceSettingsSnapshot } from "../test-helpers/native-device-settings.ts";
import { cronRuns } from "./cron-fixtures.test-support.ts";

// WEB-1 uses the existing device contract; its macOS snapshot remains unchanged.
export async function installExistingNativeDeviceSettings(page: Page): Promise<void> {
  await page.addInitScript((snapshot) => {
    Object.assign(window, { __OPENCLAW_NATIVE_DEVICE_SETTINGS__: snapshot });
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: {
        messageHandlers: {
          openclawDeviceSettings: {
            postMessage() {
              return Promise.resolve(snapshot);
            },
          },
        },
      },
    });
  }, createNativeDeviceSettingsSnapshot());
}

export function createNativeEmbedLayoutMethodResponses(): Record<string, unknown> {
  const timestamp = Date.UTC(2026, 8, 5, 12);
  const jobs: CronJobsListResult["jobs"] = [
    {
      id: "synthetic-healthy",
      configRevision: "synthetic-healthy-revision",
      name: "Healthy automation",
      enabled: true,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "Synthetic healthy automation" },
      state: { lastRunStatus: "ok" },
    },
    {
      id: "synthetic-failing",
      configRevision: "synthetic-failing-revision",
      name: "Failing automation",
      enabled: true,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "Synthetic failing automation" },
      state: { lastRunStatus: "error" },
    },
  ];

  return {
    "channels.status": {
      ts: 0,
      channels: {},
      channelAccounts: {},
      channelOrder: [],
      channelLabels: {},
      channelDefaultAccountId: {},
    } satisfies ChannelsStatusSnapshot,
    "channels.pairing.list": {
      accounts: [],
      requests: [],
      commandOwnerConfigured: false,
      limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
    } satisfies ChannelsPairingListResult,
    "webSearch.status": {
      enabled: true,
      provider: null,
      agentId: "main",
      model: {
        provider: "openai",
        id: "gpt-5.6-luna",
        runtime: "openclaw",
        runtimeLabel: "OpenClaw",
      },
      route: {
        kind: "managed",
        provider: "parallel-free",
        label: "Parallel Search (Free)",
        testable: true,
      },
      providers: [
        {
          id: "parallel-free",
          pluginId: "parallel",
          label: "Parallel Search (Free)",
          hint: "Free hosted web search",
          configured: true,
          installed: true,
          available: true,
          requiresCredential: false,
          credentialSource: "none",
          configPath: [],
        },
      ],
    } satisfies WebSearchStatusResult,
    "agents.list": {
      agents: [
        { id: "main", identity: { name: "Example assistant" }, name: "Example assistant" },
        { id: "writer", identity: { name: "Example writer" }, name: "Example writer" },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
    },
    "node.list": { nodes: [] },
    "device.pair.list": {
      pending: [],
      paired: [
        {
          deviceId: "synthetic-phone-device-with-a-long-identifier",
          displayName: "Example phone",
          platform: "ios",
          roles: ["operator"],
          scopes: ["operator.admin", "operator.read"],
          connected: true,
          createdAtMs: timestamp,
          tokens: [
            {
              role: "operator",
              scopes: ["operator.admin", "operator.read", "operator.approvals"],
              createdAtMs: timestamp,
            },
          ],
        },
      ],
    } satisfies DevicePairingList,
    "secrets.store.list": {
      entries: [
        {
          name: "SYNTHETIC_EXAMPLE_KEY",
          kind: "secret",
          scopeKind: "team",
          scopeId: "",
          createdAtMs: timestamp,
          updatedAtMs: timestamp,
          allowedHosts: ["long-service-hostname.example.invalid"],
        },
        {
          name: "SYNTHETIC_SERVICE_URL",
          kind: "env",
          value: "https://example.invalid/long/path/for-phone-wrapping",
          scopeKind: "team",
          scopeId: "",
          createdAtMs: timestamp,
          updatedAtMs: timestamp,
        },
      ],
    } satisfies SecretsStoreListResult,
    "diagnostics.lanes": {
      lanes: [
        {
          lane: "synthetic-long-background-lane-name",
          activeCount: 1,
          maxConcurrent: 2,
          queuedCount: 1,
          draining: false,
          generation: 0,
          group: "Example workers",
          groupActive: 1,
          groupBudget: 2,
          blockedBy: null,
        },
      ],
      dynamic: { laneCount: 3, activeCount: 1, queuedCount: 2, queuedLaneCount: 1 },
    } satisfies CommandLaneDiagnostics,
    "approval.history": {
      items: [
        {
          id: "synthetic-phone-approval",
          status: "allowed",
          presentation: {
            kind: "exec",
            commandText: "echo synthetic-phone-layout-approval-command",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
          urlPath: "/approve/synthetic-phone-approval",
          createdAtMs: timestamp - 1_000,
          expiresAtMs: timestamp + 60_000,
          resolvedAtMs: timestamp,
          decision: "allow-once",
          reason: "user",
          source: { agentId: "main", sessionKey: "agent:main:synthetic-phone-layout" },
          resolver: { kind: "device", id: "synthetic-reviewer-device" },
        },
      ],
    } satisfies ApprovalHistoryResult,
    "exec.approval.grants.list": {
      grants: [
        {
          grantId: "synthetic-standing-grant",
          agentId: "main",
          cronJobId: "synthetic-healthy",
          cronJobName: "Healthy automation",
          command: "echo synthetic-phone-layout-standing-grant",
          cwd: null,
          createdAtMs: timestamp,
          expiresAtMs: null,
          revokedAtMs: null,
          revokedBy: null,
          lastUsedAtMs: timestamp,
          useCount: 3,
        },
      ],
    },
    "cron.list": cronListResponseFixture({
      jobs,
      snapshotRevision: "native-embed-layout",
      total: jobs.length,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    }),
    "cron.runs": cronRuns([]),
    "cron.status": {
      enabled: true,
      triggersEnabled: true,
      jobs: jobs.length,
      nextWakeAtMs: null,
    },
  };
}
