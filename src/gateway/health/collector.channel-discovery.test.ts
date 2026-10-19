import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import * as packageState from "../../channels/plugins/package-state-probes.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../../channels/plugins/types.public.js";
import * as configRuntime from "../../config/config.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
import { collectGatewayHealthSnapshot } from "./collector.js";

let state: OpenClawTestState | undefined;
const agents: OpenClawConfig["agents"] = {
  ownership: "explicit",
  defaults: { systemAgent: { agentId: "main" } },
  entries: { main: {} },
};

afterEach(async () => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
  clearPluginMetadataLifecycleCaches();
  await state?.cleanup();
  state = undefined;
});

it("includes admitted accounts without operational hooks in public health", async () => {
  state = await createOpenClawTestState({ label: "health-admitted-accounts" });
  const config: OpenClawConfig = {
    agents,
    bindings: [{ agentId: "main", match: { channel: "admitted-chat", accountId: "bound" } }],
  };
  vi.spyOn(configRuntime, "getRuntimeConfig").mockReturnValue(config);
  const resolveAccount = vi.fn((_cfg: OpenClawConfig, accountId?: string | null) => {
    if (accountId !== "primary" && accountId !== "bound") {
      throw new Error("admitted account has no current operational configuration");
    }
    return { accountId, enabled: true, configured: true };
  });
  const inspectAccount = vi.fn(resolveAccount);
  const probeAccount = vi.fn(async () => ({ ok: true, credential: "private-live-probe" }));
  const buildChannelSummary = vi.fn(({ account }: { account: { accountId: string } }) => ({
    name: `Resolved ${account.accountId}`,
  }));
  const plugin: ChannelPlugin<ReturnType<typeof resolveAccount>> = {
    ...createChannelTestPluginBase({ id: "admitted-chat" }),
    config: {
      listAccountIds: () => ["primary"],
      resolveAccount,
      inspectAccount,
      isEnabled: (account) => account.enabled,
      isConfigured: (account) => account.configured,
    },
    status: { probeAccount, buildChannelSummary },
  };
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "admitted-owner", plugin, source: "fixture" }]),
  );
  const { recovered, recoveredFacts, retrying } = createRecordedAccountSnapshots();
  const terminal: ChannelAccountSnapshot = {
    accountId: "terminal",
    enabled: true,
    configured: true,
    running: false,
    lifecycle: "blocked",
    terminalDisconnect: true,
    lastError: "account requires login",
  };
  const snapshot = await collectGatewayHealthSnapshot({
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
          retrying: { ...retrying },
          terminal: { ...terminal },
        },
      },
    },
  });

  const channel = expectDefined(snapshot.channels["admitted-chat"], "admitted channel health");
  expect(channel).toMatchObject({ accountId: "bound", name: "Resolved bound" });
  const accounts = expectDefined(channel.accounts, "admitted account health records");
  const accountIds = Object.keys(accounts).toSorted();
  expect(accountIds).toEqual(["bound", "primary", "recovered", "retrying", "terminal"]);
  expect(accounts).toMatchObject({
    primary: { accountId: "primary", configured: true, running: false, name: "Resolved primary" },
    recovered: {
      ...recoveredFacts,
      baseUrl: "https://chat.example.test/?token=***",
      audience: "https://audience.example.test/?token=***",
    },
    retrying,
    terminal: { ...terminal, healthState: "terminal-disconnect" },
  });
  const admitted = expectDefined(accounts.recovered, "admitted runtime health");
  expect(admitted.connected).toBeUndefined();
  for (const field of Object.keys(recovered).filter(
    (key) => !(key in recoveredFacts) && key !== "baseUrl",
  )) {
    expect(admitted[field], field).toBeUndefined();
  }
  for (const resolve of [resolveAccount, inspectAccount]) {
    expect(new Set(resolve.mock.calls.map((call) => call[1]))).toEqual(
      new Set(["primary", "bound"]),
    );
  }
  for (const hook of [probeAccount, buildChannelSummary]) {
    expect(hook).toHaveBeenCalledTimes(2);
  }
  expect(accounts.primary?.probe).toBeUndefined();
  expect(JSON.stringify(snapshot)).not.toContain("private-live-probe");
});

it("uses admitted channels and configured failures without credential discovery", async () => {
  state = await createOpenClawTestState({ label: "health-channel-discovery" });
  const config: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {} } },
    channels: {
      "failed-chat": {
        accounts: { default: { enabled: true }, disabled: { enabled: false } },
      },
    },
  };
  vi.spyOn(configRuntime, "getRuntimeConfig").mockReturnValue(config);
  setGatewayPluginMetadataSnapshot(
    createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([
        {
          id: "failed-owner",
          origin: "bundled",
          channels: ["failed-chat"],
          channelConfigs: { "failed-chat": { schema: { type: "object" } } },
        },
      ]),
    }),
    { config },
  );
  const account = { accountId: "default", enabled: true, configured: true, linked: true };
  const probeAccount = vi.fn(async () => ({ ok: true }));
  const registered = createChannelTestPluginBase({
    id: "linked-chat",
    config: { resolveAccount: () => account, inspectAccount: () => account },
  });
  const registry = createTestRegistry([
    {
      pluginId: "linked-owner",
      plugin: { ...registered, status: { probeAccount } },
      source: "fixture",
    },
  ]);
  registry.plugins.push(
    createPluginRecord({
      id: "failed-owner",
      enabled: true,
      activated: true,
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
  const snapshot = await collectGatewayHealthSnapshot({
    audience: "admin",
    probe: true,
    runtimeSnapshot: { channels: {}, channelAccounts: {} },
  });

  expect(checkPersistedAuth).not.toHaveBeenCalled();
  expect(snapshot.channelOrder.toSorted()).toEqual(["failed-chat", "linked-chat"]);
  expect(snapshot.channels["linked-chat"]).toMatchObject({
    configured: true,
    linked: true,
    probe: { ok: true },
  });
  expect(probeAccount).toHaveBeenCalledOnce();
  expect(snapshot.channels["failed-chat"]?.accounts).toMatchObject({
    default: { enabled: true, configured: true, running: false, lifecycle: "blocked" },
    disabled: { enabled: false, configured: true, running: false, lifecycle: "blocked" },
  });
  expect(snapshot.plugins?.errors).toMatchObject([
    {
      id: "failed-owner",
      error: expect.stringContaining("failed to load"),
    },
  ]);
});
