// Verifies channel status snapshots use the account shape expected by plugin status hooks.
import { describe, expect, it, vi } from "vitest";
import { buildChannelAccountSnapshot } from "./status.js";
import type { ChannelPlugin } from "./types.plugin.js";

type TestAccount = {
  accountId: string;
  authToken: string;
  fromNumber: string;
};

describe("buildChannelAccountSnapshot", () => {
  it("passes resolved accounts to plugin-owned status snapshot builders", async () => {
    const inspectAccount = vi.fn(() => ({
      enabled: true,
      configured: false,
      tokenStatus: "missing",
    }));
    const resolveAccount = vi.fn(
      (): TestAccount => ({
        accountId: "default",
        authToken: "resolved-token",
        fromNumber: "+15557654321",
      }),
    );
    const buildAccountSnapshot = vi.fn(({ account }: { account: TestAccount }) => ({
      accountId: account.accountId,
      name: account.fromNumber,
      configured: Boolean(account.authToken && account.fromNumber),
    }));
    const plugin = {
      id: "sms",
      config: {
        inspectAccount,
        resolveAccount,
      },
      status: {
        buildAccountSnapshot,
      },
    } as unknown as ChannelPlugin<TestAccount>;

    const snapshot = await buildChannelAccountSnapshot({
      plugin,
      cfg: {},
      accountId: "default",
      runtime: {
        accountId: "default",
        running: true,
        connected: true,
      },
    });

    expect(inspectAccount).not.toHaveBeenCalled();
    expect(resolveAccount).toHaveBeenCalledWith({}, "default");
    expect(buildAccountSnapshot).toHaveBeenCalledWith({
      account: {
        accountId: "default",
        authToken: "resolved-token",
        fromNumber: "+15557654321",
      },
      audit: undefined,
      cfg: {},
      probe: undefined,
      runtime: {
        accountId: "default",
        running: true,
        connected: true,
      },
    });
    expect(snapshot).toMatchObject({
      accountId: "default",
      name: "+15557654321",
      configured: true,
      running: true,
      connected: true,
    });
  });
});
