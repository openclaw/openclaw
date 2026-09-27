import { beforeAll, expect, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../../commands/models/auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { registerPluginCommand } from "../../plugins/commands.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { PluginCommandContext } from "../../plugins/types.js";
import { linkUserChannelIdentity } from "../../state/user-channel-identities.js";
import { ensureProfileForEmail, setUserProfileRole } from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextAsyncParams,
  type BuildChannelInboundEventContextParams,
  type BuiltChannelInboundEventContext,
} from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import type { ChannelPlugin } from "../plugins/types.public.js";
import { createCommandOwnerTestGateway } from "./operator-authority.test-support.js";
import { createHostChannelIngressRuntime } from "./runtime.js";

type TelegramNativeCommandTestDriver = {
  invoke: (input?: {
    command?: string;
    senderId?: number;
    chatId?: number;
    group?: boolean;
    threadId?: number;
    match?: string;
  }) => Promise<void>;
  pairingStoreReadCount: () => number;
  deliveries: () => Array<{ replies: ReplyPayload[] }>;
  sentMessages: () => Array<{ chatId: number | string; text: string }>;
  configureLogin: (input: {
    run: (options: ModelsAuthLoginFlowOptions) => Promise<ModelsAuthLoginFlowResult>;
    onResult: () => void;
  }) => void;
  close: () => void;
};
const { createTelegramNativeCommandTestDriver } = await loadBundledPluginFacade<{
  createTelegramNativeCommandTestDriver: (options: {
    cfg: OpenClawConfig;
    runtime: PluginRuntime;
  }) => TelegramNativeCommandTestDriver;
}>({
  pluginId: "telegram",
  artifactBasename: "native-command.test-support.js",
});
let telegramPlugin: ChannelPlugin;

beforeAll(async () => {
  ({ telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
    pluginId: "telegram",
    artifactBasename: "api.js",
  }));
});

export async function withTelegramNativeOwners(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  asserted = false,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const previous = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
      null,
      "default",
    );
    const fixture = createFixture(asserted, state);
    try {
      await run(fixture);
    } finally {
      fixture.close();
      rollbackStagedPluginRegistry(previous);
    }
  });
}

function createFixture(asserted: boolean, state: OpenClawTestState) {
  const cfg: OpenClawConfig = {
    commands: { ownerAllowFrom: ["telegram:999999"] },
    channels: { telegram: { dmPolicy: "pairing", allowFrom: [] } },
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
  const admins = [100, 200].map((senderId) => {
    const profile = ensureProfileForEmail(`admin-${senderId}@example.test`);
    setUserProfileRole(profile.id, "admin");
    const identity = { channelId: "telegram", accountId: "default", senderId: String(senderId) };
    linkUserChannelIdentity(profile.id, identity);
    return { profile, identity };
  });
  let live = true;
  const gateway = createCommandOwnerTestGateway(cfg);
  const host = { channelId: "telegram", isLive: () => live, resolveGatewayContext: () => gateway };
  const ingress = createHostChannelIngressRuntime(host);
  const handler = vi.fn(async (ctx: PluginCommandContext) => {
    ctx.assertOwnerCurrent?.();
    return { text: "TELEGRAM-OWNER-OK" };
  });
  expect(
    registerPluginCommand("owner-probe", {
      name: "qaowner",
      description: "Owner authority probe",
      requiredScopes: ["operator.admin"],
      handler,
    }),
  ).toEqual({ ok: true });
  const buildHostContext = createHostChannelInboundEventContextBuilder(
    buildChannelInboundEventContext,
    host,
  );
  function buildContext(
    input: BuildChannelInboundEventContextAsyncParams,
  ): Promise<BuiltChannelInboundEventContext>;
  function buildContext(
    input: BuildChannelInboundEventContextParams,
  ): BuiltChannelInboundEventContext;
  function buildContext(input: BuildChannelInboundEventContextParams) {
    return buildHostContext(input);
  }
  const runtime = createPluginRuntimeMock({
    channel: {
      inbound: {
        ingress: asserted
          ? {
              ...ingress,
              createResolver: (base) => {
                const resolver = ingress.createResolver(base);
                return {
                  ...resolver,
                  event: (input) =>
                    resolver.event({
                      ...input,
                      subject: {
                        ...input.subject,
                        authentication: { "telegram-user-id": "asserted" },
                      },
                    }),
                };
              },
            }
          : ingress,
        buildContext,
      },
    },
  });
  const driver = createTelegramNativeCommandTestDriver({ cfg, runtime });
  return {
    state,
    cfg,
    admins,
    handler,
    driver,
    invoke: (senderId = 100) => driver.invoke({ senderId }),
    invokeTopic: () => driver.invoke({ group: true, chatId: -10012345, threadId: 42 }),
    close: () => {
      live = false;
      driver.close();
    },
  };
}
