import { beforeAll, vi } from "vitest";
import type { DispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.types.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import type { PluginCommandNativeCandidate } from "../../plugins/plugin-command-runtime.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { linkUserChannelIdentity } from "../../state/user-channel-identities.js";
import { ensureProfileForEmail, setUserProfileRole } from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { buildChannelInboundEventContext } from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import type { ChannelPlugin } from "../plugins/types.public.js";
import { createHostChannelIngressRuntime } from "./runtime.js";

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
    gateway: {
      roles: {
        default: "member",
        definitions: {
          admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
          member: {
            scopes: ["operator.read", "operator.write"],
            agents: "*",
            sessions: { others: "view" },
          },
        },
      },
    },
  };
  const profile = ensureProfileForEmail("ada@example.test");
  setUserProfileRole(profile.id, "admin");
  linkUserChannelIdentity(profile.id, {
    channelId: "discord",
    accountId: "default",
    senderId: "123456789012345678",
  });
  // SAFETY: This synthetic Gateway provides the only context operation consumed by ingress authority.
  const gateway = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
  let live = true;
  const host = {
    channelId: "discord",
    isLive: () => live,
    resolveGatewayContext: () => gateway,
  };
  const dispatch = vi.fn<DispatchReplyFromConfig>(async ({ dispatcher }) => ({
    queuedFinal: dispatcher.sendFinalReply({ text: "accepted" }),
    counts: dispatcher.getQueuedCounts(),
  }));
  const createCommandOptions = (threadBindings: object) => ({
    command: { name: "ping", description: "Ping", acceptsArgs: false },
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings,
    buildContext: createHostChannelInboundEventContextBuilder(
      buildChannelInboundEventContext,
      host,
    ),
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
      channel: {
        inbound: {
          ingress: createHostChannelIngressRuntime(host),
        },
      },
    }),
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
    const command = createDiscordNativeCommand({
      ...createCommandOptions(createNoopThreadBindingManager("default")),
      command: options.pluginCommand ?? {
        name: options.commandName ?? "ping",
        description: "Test command",
        acceptsArgs: true,
      },
    });
    const interaction = createInteraction(options);
    await command.run(interaction);
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
      const command = createDiscordNativeCommand({
        ...createCommandOptions(createNoopThreadBindingManager("default")),
        command: { name: "think", description: "Thinking level", acceptsArgs: true },
      });
      const complete = command.options?.find((option) => option.name === "level")?.autocomplete;
      if (!complete) {
        throw new Error("Expected the registered /think level autocomplete handler");
      }
      const interaction = createAutocompleteInteraction();
      await complete(interaction);
      return interaction;
    },
    close: () => {
      live = false;
    },
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
    const previousRegistry = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", plugin: discordPlugin, source: "test" }]),
      null,
      "default",
    );
    try {
      const fixture = await createFixture(state);
      try {
        await test(fixture);
      } finally {
        fixture.close();
      }
    } finally {
      rollbackStagedPluginRegistry(previousRegistry);
    }
  });
}
