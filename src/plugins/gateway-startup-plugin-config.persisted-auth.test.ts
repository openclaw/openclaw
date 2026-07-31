import { beforeEach, describe, expect, it, vi } from "vitest";

const listPotentialConfiguredChannelIds = vi.hoisted(() =>
  vi.fn(
    (
      _config: unknown,
      _env: NodeJS.ProcessEnv,
      options?: { includePersistedAuthState?: boolean },
    ) => (options?.includePersistedAuthState ? ["credential-only"] : []),
  ),
);
const listPotentialConfiguredChannelPresenceSignals = vi.hoisted(() =>
  vi.fn(
    (
      _config: unknown,
      _env: NodeJS.ProcessEnv,
      options?: { includePersistedAuthState?: boolean },
    ) =>
      options?.includePersistedAuthState
        ? [{ channelId: "credential-only", source: "persisted-auth" }]
        : [],
  ),
);
const listExplicitlyDisabledChannelIdsForConfig = vi.hoisted(() => vi.fn((): string[] => []));

vi.mock("../channels/config-presence.js", () => ({
  listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelIds,
  listPotentialConfiguredChannelPresenceSignals,
}));

vi.mock("./channel-presence-policy.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: () => [],
}));

import { collectConfiguredStartupChannelIds } from "./gateway-startup-plugin-config.js";

describe("collectConfiguredStartupChannelIds persisted auth", () => {
  beforeEach(() => {
    listPotentialConfiguredChannelIds.mockClear();
    listPotentialConfiguredChannelPresenceSignals.mockClear();
    listExplicitlyDisabledChannelIdsForConfig.mockReset();
    listExplicitlyDisabledChannelIdsForConfig.mockReturnValue([]);
  });

  it("does not treat credential-only state as startup activation by default", () => {
    expect(
      collectConfiguredStartupChannelIds({
        config: {},
        activationSourceConfig: {},
        env: {},
      }),
    ).toEqual([]);
    expect(listPotentialConfiguredChannelIds).toHaveBeenCalledTimes(2);
    for (const call of listPotentialConfiguredChannelIds.mock.calls) {
      expect(call[2]?.includePersistedAuthState).toBe(false);
    }
  });

  it("allows migration discovery to opt into credential-only state", () => {
    expect(
      collectConfiguredStartupChannelIds({
        config: {},
        activationSourceConfig: {},
        env: {},
        includePersistedAuthState: true,
      }),
    ).toEqual(["credential-only"]);
  });

  it("keeps disabled persisted state for migration without activating it at startup", () => {
    listExplicitlyDisabledChannelIdsForConfig.mockReturnValue(["credential-only"]);
    const params = {
      config: {},
      activationSourceConfig: {},
      env: {},
    };

    expect(collectConfiguredStartupChannelIds(params)).toEqual([]);
    expect(
      collectConfiguredStartupChannelIds({ ...params, includePersistedAuthState: true }),
    ).toEqual(["credential-only"]);
  });

  it("does not restore disabled ordinary signals during migration discovery", () => {
    listExplicitlyDisabledChannelIdsForConfig.mockReturnValue(["credential-only"]);
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([]);
    listPotentialConfiguredChannelIds.mockReturnValue(["credential-only"]);

    expect(
      collectConfiguredStartupChannelIds({
        config: {},
        activationSourceConfig: {},
        env: {},
        includePersistedAuthState: true,
      }),
    ).toEqual([]);
  });
});
