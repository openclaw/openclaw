import { assert, expect, it, type vi } from "vitest";
import type { RuntimeConfigWriteApplicationStatus } from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryBeginGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveNormalizedAccountEntry } from "../routing/account-lookup.js";
import { isRecord } from "../utils.js";
import type { createChannelManager } from "./server-channels.js";

export function createManagedChannelFixtureAccountConfig() {
  const readChannel = (config: OpenClawConfig) => {
    const channel = config.channels?.mattermost;
    if (!isRecord(channel) || !isRecord(channel.accounts)) {
      throw new Error("Expected channel-account fixture");
    }
    return { channel, accounts: channel.accounts };
  };
  return {
    listAccountIds: (config: OpenClawConfig) =>
      Object.keys(readChannel(config).accounts).map(normalizeAccountId),
    resolveAccount: (config: OpenClawConfig, requestedAccountId?: string | null) => {
      const accountId = normalizeAccountId(requestedAccountId);
      const { channel, accounts } = readChannel(config);
      const account = resolveNormalizedAccountEntry(accounts, accountId, normalizeAccountId);
      if (!isRecord(account)) {
        throw new Error(`Account ${accountId} no longer exists`);
      }
      return {
        accountId,
        botToken: account.botToken ?? channel.botToken,
        enabled: channel.enabled !== false && account.enabled !== false,
      };
    },
  };
}

type ChannelRemovalFixture = {
  nextSource: (providerPath: string) => OpenClawConfig;
  oldPath: string;
  missingPath: string;
  starts: Array<{ accountId: string; token: unknown }>;
  stops: string[];
  channelReloadDeferred: Promise<void>;
  manager: ReturnType<typeof createChannelManager>;
  write: (config: OpenClawConfig) => Promise<RuntimeConfigWriteApplicationStatus>;
  requestRecoveryRestart: ReturnType<typeof vi.fn>;
};

export function registerManagedChannelRemovalTests(
  withFixture: (
    run: (fixture: ChannelRemovalFixture) => Promise<void>,
    authoredKeys?: boolean,
  ) => Promise<void>,
) {
  it.each([
    { accountId: "root", configKey: "root", stopped: false, authoredKeys: false },
    { accountId: "ada", configKey: "ada", stopped: true, authoredKeys: false },
    { accountId: "root", configKey: "Root", stopped: false, authoredKeys: true },
    { accountId: "ada", configKey: "Ada", stopped: true, authoredKeys: true },
  ])(
    "removes account $configKey (stopped=$stopped) without interrupting its sibling or waiting for unrelated requests",
    async ({ accountId, configKey, stopped, authoredKeys }) => {
      await withFixture(async (fixture) => {
        const next = fixture.nextSource(fixture.oldPath);
        const channel = next.channels?.mattermost;
        if (!isRecord(channel) || !isRecord(channel.accounts)) {
          throw new Error("Expected account fixture");
        }
        if (stopped) {
          await fixture.manager.stopChannel("mattermost", accountId);
          fixture.stops.length = 0;
        }
        delete channel.accounts[configKey];
        const unrelatedRequest = tryBeginGatewayRootWorkAdmission();
        assert(unrelatedRequest);
        try {
          expect(
            await Promise.race([
              fixture.write(next),
              fixture.channelReloadDeferred.then(() => "deferred"),
            ]),
          ).toBe("applied");
          expect(fixture.stops).toEqual(stopped ? [] : [accountId]);
          expect(fixture.starts).toEqual([]);
          const sibling = accountId === "root" ? "ada" : "root";
          expect(fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost).toMatchObject({
            [sibling]: { running: true },
          });
          expect(
            fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost,
          ).not.toHaveProperty(accountId);
          expect(fixture.manager.resolveRuntimeAccountId("mattermost", accountId)).toBeUndefined();
          expect(fixture.manager.isManuallyStopped("mattermost", accountId)).toBe(false);
          expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
        } finally {
          unrelatedRequest.release();
        }
      }, authoredKeys);
    },
  );

  it("restarts an edited authored account instead of treating it as removed", async () => {
    await withFixture(async (fixture) => {
      const next = fixture.nextSource(fixture.oldPath);
      const channel = next.channels?.mattermost;
      if (!isRecord(channel) || !isRecord(channel.accounts)) {
        throw new Error("Expected account fixture");
      }
      channel.accounts.Root = { botToken: "replacement-token" };
      expect(await fixture.write(next)).toBe("applied");
      expect(fixture.stops).toEqual(["root"]);
      expect(fixture.starts).toEqual([{ accountId: "root", token: "replacement-token" }]);
      expect(fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost).toMatchObject({
        root: { running: true },
        ada: { running: true },
      });
      expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
    }, true);
  });

  it("prunes a removed account when its surviving sibling becomes cold", async () => {
    await withFixture(async (fixture) => {
      const next = fixture.nextSource(fixture.missingPath);
      const channel = next.channels?.mattermost;
      if (!isRecord(channel) || !isRecord(channel.accounts)) {
        throw new Error("Expected account fixture");
      }
      delete channel.accounts.root;
      expect(await fixture.write(next)).toBe("applied");
      expect(fixture.stops.toSorted()).toEqual(["ada", "root"]);
      expect(fixture.starts).toEqual([]);
      expect(fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost).not.toHaveProperty(
        "root",
      );
      expect(fixture.manager.resolveRuntimeAccountId("mattermost", "root")).toBeUndefined();
      expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
    });
  });
}
