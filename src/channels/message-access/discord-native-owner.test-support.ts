import { beforeAll, vi } from "vitest";
import type { DispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.types.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import type { PluginCommandNativeCandidate } from "../../plugins/plugin-command-runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { linkUserChannelIdentity } from "../../state/user-channel-identities.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { ChannelPlugin } from "../plugins/types.public.js";
import { createHostIngressFixture, withTestChannelRegistry } from "./host-ingress.test-support.js";
import { createCommandOwnerTestRoles } from "./operator-authority.test-support.js";

beforeAll(async () => {
  // Finish cold plugin imports before any case changes process-global state.
  await Promise.all(
    ["api.js", "runtime-api.js"].map((artifactBasename) =>
      loadBundledPluginFacade({ pluginId: "discord", artifactBasename }),
    ),
  );
});

function createInteraction(options: { senderId?: string; argument?: string } = {}) {
  return {
    user: { id: options.senderId ?? "123456789012345678", username: "ada", globalName: "Ada" },
    channel: { type: 0, id: "234567890123456789" },
    guild: { id: "345678901234567890", name: "Test Guild" },
    rawData: { id: "interaction-1", member: { roles: [] } },
    options: {
      getString: () => options.argument ?? null,
      getNumber: () => null,
      getBoolean: () => null,
    },
    responseState: "deferred",
    defer: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    client: {},
  };
}

function createAutocompleteInteraction() {
  const interaction = createInteraction();
  return {
    ...interaction,
    options: { ...interaction.options, getFocused: () => ({ name: "level", value: "" }) },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

async function createFixture(state: OpenClawTestState) {
  const cfg: OpenClawConfig = {
    commands: { ownerAllowFrom: ["discord:999999999999999999"] },
    channels: {
      discord: {
        groupPolicy: "allowlist",
        guilds: {
          "345678901234567890": {
            channels: { "234567890123456789": { enabled: true, requireMention: false } },
          },
        },
      },
    },
    gateway: { roles: createCommandOwnerTestRoles() },
  };
  const profile = ensureProfileForEmail("ada@example.test");
  setUserProfileRole(profile.id, "admin");
  linkUserChannelIdentity(profile.id, {
    channelId: "discord",
    accountId: "default",
    senderId: "123456789012345678",
  });
  const host = createHostIngressFixture("discord", cfg);
  const dispatch = vi.fn<DispatchReplyFromConfig>(async ({ dispatcher }) => ({
    queuedFinal: dispatcher.sendFinalReply({ text: "accepted" }),
    counts: dispatcher.getQueuedCounts(),
  }));
  const createCommandOptions = (
    threadBindings: object,
    name: string,
    pluginCommand?: PluginCommandNativeCandidate,
  ) => ({
    command: pluginCommand ?? { name, description: "Test command", acceptsArgs: true },
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings,
    buildContext: host.buildContext,
    dispatchReplyFromConfig: dispatch,
  });
  const { createDiscordNativeCommand, createNoopThreadBindingManager, setDiscordRuntime } =
    await loadBundledPluginFacade<{
      createDiscordNativeCommand: (options: ReturnType<typeof createCommandOptions>) => {
        run: (interaction: ReturnType<typeof createInteraction>) => Promise<void>;
        options?: Array<{
          name: string;
          autocomplete?: (
            interaction: ReturnType<typeof createAutocompleteInteraction>,
          ) => Promise<void>;
        }>;
      };
      createNoopThreadBindingManager: (accountId: string) => object;
      setDiscordRuntime: (runtime: PluginRuntime) => void;
    }>({ pluginId: "discord", artifactBasename: "runtime-api.js" });
  setDiscordRuntime(
    createPluginRuntimeMock({
      channel: { inbound: { ingress: host.ingress } },
    }),
  );
  const createCommand = (name: string, candidate?: PluginCommandNativeCandidate) =>
    createDiscordNativeCommand(
      createCommandOptions(createNoopThreadBindingManager("default"), name, candidate),
    );
  const run = async (
    options: {
      senderId?: string;
      commandName?: string;
      argument?: string;
      pluginCommand?: PluginCommandNativeCandidate;
    } = {},
  ) => {
    dispatch.mockClear();
    const interaction = createInteraction(options);
    await createCommand(options.commandName ?? "ping", options.pluginCommand).run(interaction);
    return interaction;
  };
  return {
    cfg,
    profile,
    state,
    publishConfig: () => setRuntimeConfigSnapshot(cfg, cfg),
    run,
    dispatch,
    autocomplete: async () => {
      const command = createCommand("think");
      const complete = command.options?.find((option) => option.name === "level")?.autocomplete;
      if (!complete) {
        throw new Error("Expected the registered /think level autocomplete handler");
      }
      const interaction = createAutocompleteInteraction();
      await complete(interaction);
      return interaction;
    },
    close: host.retire,
  };
}

export async function withDiscordNativeAdminFixture(
  test: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
      pluginId: "discord",
      artifactBasename: "api.js",
    });
    await withTestChannelRegistry(discordPlugin, async () => {
      const fixture = await createFixture(state);
      using _ = { [Symbol.dispose]: () => fixture.close() };
      await test(fixture);
    });
  });
}
