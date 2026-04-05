import { describe, expect, it } from "vitest";
import { applyChannelDoctorCompatibilityMigrations } from "./channel-legacy-config-migrate.js";

describe("bundled channel legacy config migrations", () => {
  it("normalizes legacy private-network aliases exposed through bundled contract surfaces", () => {
    const result = applyChannelDoctorCompatibilityMigrations({
      channels: {
        mattermost: {
          allowPrivateNetwork: true,
          accounts: {
            work: {
              allowPrivateNetwork: false,
            },
          },
        },
      },
    });

    const nextChannels = (result.next.channels ?? {}) as {
      mattermost?: Record<string, unknown>;
    };

    expect(nextChannels.mattermost).toEqual({
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
      accounts: {
        work: {
          network: {
            dangerouslyAllowPrivateNetwork: false,
          },
        },
      },
    });
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Moved channels.mattermost.allowPrivateNetwork → channels.mattermost.network.dangerouslyAllowPrivateNetwork (true).",
        "Moved channels.mattermost.accounts.work.allowPrivateNetwork → channels.mattermost.accounts.work.network.dangerouslyAllowPrivateNetwork (false).",
      ]),
    );
  });
});
