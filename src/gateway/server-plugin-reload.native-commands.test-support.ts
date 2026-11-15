import assert from "node:assert/strict";
import { expect } from "vitest";
import {
  createPluginCommandRuntime,
  type PluginCommandCatalogDecision,
} from "../plugins/plugin-command-runtime.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import {
  createRecoveryChannelManager,
  type RecoveryFixtureFactory,
  waitForChannelAbort,
} from "./server-plugin-reload.recovery.test-support.js";

/** A retained command entry must not keep a channel on a retired registry's candidates. */
export async function verifyRetainedNativeCommandRefresh(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  const channelId = "retained-native";
  const dispatches: PluginCommandCatalogDecision[] = [];
  let plainStarts = 0;
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    register(api, owner) {
      if (owner !== "sibling") {
        return;
      }
      api.registerCommand({
        name: "kept",
        description: "Kept",
        handler: async () => ({ text: "ran" }),
      });
      const base = createChannelTestPluginBase({ id: channelId });
      api.registerChannel({
        plugin: {
          ...base,
          capabilities: { ...base.capabilities, nativeCommands: true },
          gateway: {
            startAccount: async ({ abortSignal }) => {
              const [command] = createPluginCommandRuntime().listNativeCandidates(channelId);
              dispatches.push(command!.prepareDispatch());
              await waitForChannelAbort(abortSignal);
            },
          },
        },
      });
      api.registerChannel({
        plugin: {
          ...createChannelTestPluginBase({ id: "retained-plain" }),
          gateway: {
            startAccount: async ({ abortSignal }) => {
              plainStarts += 1;
              await waitForChannelAbort(abortSignal);
            },
          },
        },
      });
    },
  });
  const manager = createRecoveryChannelManager(fixture);
  fixture.runtime.channelManager = manager;
  try {
    await manager.startChannel(channelId);
    await manager.startChannel("retained-plain");
    await fixture.reload();
    // Only the channel holding native command candidates is restarted.
    expect([dispatches.length, plainStarts]).toEqual([2, 1]);
    const latest = dispatches.at(-1);
    assert(latest?.kind === "plugin");
    const context = {
      channel: channelId,
      isAuthorizedSender: true,
      commandBody: "/kept",
      config: {},
    };
    await expect(latest.execute(context)).resolves.toEqual({ text: "ran" });
  } finally {
    await manager.stopChannel(channelId);
    await manager.stopChannel("retained-plain");
  }
}
