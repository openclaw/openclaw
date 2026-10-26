import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as ingressHealth from "../../channels/message/ingress-queue-health.js";
import * as packageState from "../../channels/plugins/package-state-probes.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import * as configRuntime from "../../config/config.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as deliveryQueueState from "../../infra/delivery-queue-sqlite.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createRecordedAccountSnapshots } from "../server-methods/channels.status.test-helpers.js";
import { collectGatewayHealthSnapshot as collectHealth } from "./collector.js";

let state: OpenClawTestState | undefined;
const agents: OpenClawConfig["agents"] = {
  ownership: "explicit",
  defaults: { systemAgent: { agentId: "main" } },
  entries: { main: {} },
};

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "health-discovery" });
  vi.spyOn(configRuntime, "getRuntimeConfig").mockReturnValue({ agents });
  setActivePluginRegistry(createTestRegistry([]));
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
  clearPluginMetadataLifecycleCaches();
  await state?.cleanup();
  state = undefined;
});

it("reports admitted and unavailable channels without credential discovery or public leaks", async () => {
  const config: OpenClawConfig = {
    agents,
    bindings: [{ agentId: "main", match: { channel: "admitted-chat", accountId: "bound" } }],
    channels: {
      "failed-chat": { accounts: { default: { enabled: true }, disabled: { enabled: false } } },
    },
  };
  vi.mocked(configRuntime.getRuntimeConfig).mockReturnValue(config);
  const manifestRegistry = makeRegistry([
    {
      id: "failed-owner",
      origin: "bundled",
      channels: ["failed-chat"],
      channelConfigs: { "failed-chat": { schema: { type: "object" } } },
    },
  ]);
  setGatewayPluginMetadataSnapshot(createPluginMetadataSnapshot({ config, manifestRegistry }), {
    config,
  });
  const resolveAccount = (_cfg: OpenClawConfig, accountId?: string | null) => {
    if (accountId !== "primary" && accountId !== "bound") {
      throw new Error("admitted account has no current operational configuration");
    }
    return { accountId, enabled: true, configured: true, linked: true };
  };
  const probeAccount = async () => ({ ok: true, credential: "private-live-probe" });
  const buildChannelSummary = ({ account }: { account: { accountId: string } }) => ({
    name: `Resolved ${account.accountId}`,
  });
  const plugin: ChannelPlugin<ReturnType<typeof resolveAccount>> = {
    ...createChannelTestPluginBase({ id: "admitted-chat" }),
    config: {
      listAccountIds: () => ["primary"],
      resolveAccount,
      inspectAccount: resolveAccount,
      isEnabled: (account) => account.enabled,
      isConfigured: (account) => account.configured,
    },
    status: { probeAccount, buildChannelSummary },
  };
  const registry = createTestRegistry([{ pluginId: "admitted-owner", plugin, source: "fixture" }]);
  registry.plugins.push(
    createPluginRecord({
      id: "failed-owner",
      status: "error",
      failurePhase: "load",
      channelIds: ["failed-chat"],
      error: "fixture channel runtime failed to load",
    }),
  );
  setActivePluginRegistry(registry);
  vi.spyOn(packageState, "listBundledChannelIdsForPackageState").mockImplementation(
    (metadataKey) => (metadataKey === "persistedAuthState" ? ["dormant-chat"] : []),
  );
  const checkPersistedAuth = vi
    .spyOn(packageState, "hasBundledChannelPackageState")
    .mockImplementation(() => {
      throw new Error("health attempted dormant credential discovery");
    });
  const { recovered, recoveredFacts } = createRecordedAccountSnapshots();
  const snapshot = await collectHealth({
    audience: "public",
    probe: true,
    runtimeSnapshot: {
      channels: { "admitted-chat": { accountId: "primary", running: false } },
      channelAccounts: {
        "admitted-chat": {
          recovered: {
            ...recovered,
            audience:
              "https://audience-user:audience-password@audience.example.test/?token=audience-token",
          },
          terminal: { accountId: "terminal", running: false, terminalDisconnect: true },
        },
      },
    },
  });

  const channel = expectDefined(snapshot.channels["admitted-chat"], "admitted channel health");
  expect(channel).toMatchObject({ accountId: "bound", name: "Resolved bound" });
  const accounts = expectDefined(channel.accounts, "admitted account health records");
  const accountIds = Object.keys(accounts).toSorted();
  expect(accountIds).toEqual(["bound", "primary", "recovered", "terminal"]);
  expect(accounts).toMatchObject({
    primary: {
      accountId: "primary",
      configured: true,
      linked: true,
      running: false,
      name: "Resolved primary",
    },
    recovered: {
      ...recoveredFacts,
      baseUrl: "https://chat.example.test/?token=***",
      audience: "https://audience.example.test/?token=***",
    },
    terminal: { healthState: "terminal-disconnect" },
  });
  const admitted = expectDefined(accounts.recovered, "admitted runtime health");
  expect(admitted.connected).toBeUndefined();
  for (const field of Object.keys(recovered).filter(
    (key) => !(key in recoveredFacts) && key !== "baseUrl",
  )) {
    expect(admitted[field], field).toBeUndefined();
  }
  expect(accounts.primary?.probe).toBeUndefined();
  expect(JSON.stringify(snapshot)).not.toContain("private-live-probe");
  expect(checkPersistedAuth).not.toHaveBeenCalled();
  expect(snapshot.channelOrder.toSorted()).toEqual(["admitted-chat", "failed-chat"]);
  expect(snapshot.channels["failed-chat"]?.accounts).toMatchObject({
    default: { enabled: true, configured: true, running: false, lifecycle: "blocked" },
    disabled: { enabled: false, configured: true, running: false, lifecycle: "blocked" },
  });
  expect(snapshot.plugins?.errors).toMatchObject([
    { id: "failed-owner", error: expect.stringContaining("failed to load") },
  ]);
});

it("preserves ingress failures and pressure when outbound admission capture fails", async () => {
  const capture = vi
    .spyOn(deliveryQueueState, "captureDeliveryQueueStateContext")
    .mockImplementation(() => {
      throw new Error("outbound admission unavailable");
    });
  const countOutbound = vi.spyOn(deliveryQueueState, "countFailedDeliveryQueueEntries");
  const failed = [{ channelId: "telegram", accountId: "ops", count: 1 }];
  const pressure = [
    {
      channelId: "telegram",
      accountId: "ops",
      laneCount: 1,
      pendingCount: 56,
      claimedCount: 0,
      blockedCount: 55,
      oldestReceivedAt: 1_000,
    },
  ];
  vi.spyOn(ingressHealth, "countChannelIngressQueueHealth").mockResolvedValue({
    failed,
    pressure,
  });
  const pending = collectHealth({ audience: "admin", probe: false });
  expect(capture).toHaveBeenCalledTimes(1);
  expect(await pending).toMatchObject({
    channels: {},
    deliveryQueues: { failed: [], ingressFailed: failed, ingressPressure: pressure },
  });
  expect(capture).toHaveBeenCalledTimes(1);
  expect(countOutbound).not.toHaveBeenCalled();
});
