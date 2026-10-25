import { expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { SecretAssignment } from "./runtime-shared.js";

type Assignment = Pick<SecretAssignment, "ref" | "path" | "expected" | "apply">;

const { loadPluginMetadataSnapshotMock, loadChannelSecretContractApiMock } = vi.hoisted(() => ({
  loadPluginMetadataSnapshotMock: vi.fn(),
  loadChannelSecretContractApiMock: vi.fn(),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: (params: unknown) =>
    createPluginMetadataSnapshotFixture(loadPluginMetadataSnapshotMock(params)),
  resolvePluginMetadataSnapshot: (params: unknown) => {
    const snapshot = loadPluginMetadataSnapshotMock(params) as {
      plugins: Array<{ id: string; origin: "global" }>;
    };
    return createPluginMetadataSnapshotFixture({ plugins: snapshot.plugins });
  },
  listPluginOriginsFromMetadataSnapshot: (snapshot: {
    plugins: Array<{ id: string; origin: "global" }>;
  }) => new Map(snapshot.plugins.map((record) => [record.id, record.origin])),
}));

vi.mock("./channel-contract-api.js", () => ({
  loadChannelSecretContractApi: loadChannelSecretContractApiMock,
}));

import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

it("discovers loadable plugins for channel SecretRefs when plugins.entries is absent", async () => {
  const tokenRef = { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" };
  loadPluginMetadataSnapshotMock.mockReturnValue({
    plugins: [{ id: "discord", origin: "global" }],
  });
  loadChannelSecretContractApiMock.mockReturnValue({
    collectRuntimeConfigAssignments: (params: {
      config: { channels?: { discord?: { token?: unknown } } };
      context: { assignments: Assignment[] };
    }) => {
      const token = params.config.channels?.discord?.token;
      if (!token || typeof token !== "object" || Array.isArray(token)) {
        return;
      }
      params.context.assignments.push({
        ref: token as { source: "env"; provider: "default"; id: string },
        path: "channels.discord.token",
        expected: "string",
        apply: (value) => {
          if (params.config.channels?.discord) {
            params.config.channels.discord.token = value;
          }
        },
      });
    },
  });

  const snapshot = await prepareSecretsRuntimeSnapshot({
    config: asConfig({ channels: { discord: { token: tokenRef } } }),
    env: { DISCORD_BOT_TOKEN: "resolved-discord-token" },
    includeAuthStoreRefs: false,
  });

  expect(snapshot.config.channels?.discord?.token).toBe("resolved-discord-token");
  expect(loadPluginMetadataSnapshotMock).toHaveBeenCalled();
  const loadCall = loadChannelSecretContractApiMock.mock.calls[0]?.[0];
  expect(loadCall?.channelId).toBe("discord");
  expect(loadCall?.loadablePluginOrigins).toEqual(new Map([["discord", "global"]]));
});
