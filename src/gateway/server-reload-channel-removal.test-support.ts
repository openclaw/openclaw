import { assert, expect, it, type vi } from "vitest";
import type { RuntimeConfigWriteApplicationStatus } from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryBeginGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import { isRecord } from "../utils.js";
import type { createChannelManager } from "./server-channels.js";

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
  withFixture: (run: (fixture: ChannelRemovalFixture) => Promise<void>) => Promise<void>,
) {
  it.each([
    { accountId: "root", stopped: false },
    { accountId: "ada", stopped: true },
  ])(
    "removes account $accountId (stopped=$stopped) without interrupting its sibling or waiting for unrelated requests",
    async ({ accountId, stopped }) => {
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
        delete channel.accounts[accountId];
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
      });
    },
  );

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
