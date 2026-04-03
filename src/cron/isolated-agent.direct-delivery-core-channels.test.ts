import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it } from "vitest";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.js";
import type { CliDeps } from "../cli/deps.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  loadBundledPluginPublicSurfaceSync,
  loadBundledPluginTestApiSync,
} from "../test-utils/bundled-plugin-public-surface.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

type ChannelCase = {
  name: string;
  channel: "slack" | "discord" | "whatsapp" | "imessage";
  to: string;
  sendKey: keyof Pick<
    CliDeps,
    "sendMessageSlack" | "sendMessageDiscord" | "sendMessageWhatsApp" | "sendMessageIMessage"
  >;
  expectedTo: string;
};

let discordOutboundCache: ChannelOutboundAdapter | undefined;
let imessageOutboundCache: ChannelOutboundAdapter | undefined;
let signalOutboundCache: ChannelOutboundAdapter | undefined;
let slackOutboundCache: ChannelOutboundAdapter | undefined;
let telegramOutboundCache: ChannelOutboundAdapter | undefined;
let whatsappOutboundCache: ChannelOutboundAdapter | undefined;

function getDiscordOutbound(): ChannelOutboundAdapter {
  if (!discordOutboundCache) {
    ({ discordOutbound: discordOutboundCache } = loadBundledPluginTestApiSync<{
      discordOutbound: ChannelOutboundAdapter;
    }>("discord"));
  }
  return discordOutboundCache;
}

function getIMessageOutbound(): ChannelOutboundAdapter {
  if (!imessageOutboundCache) {
    ({ imessageOutbound: imessageOutboundCache } = loadBundledPluginPublicSurfaceSync<{
      imessageOutbound: ChannelOutboundAdapter;
    }>({
      pluginId: "imessage",
      artifactBasename: "src/outbound-adapter.js",
    }));
  }
  return imessageOutboundCache;
}

function getSignalOutbound(): ChannelOutboundAdapter {
  if (!signalOutboundCache) {
    ({ signalOutbound: signalOutboundCache } = loadBundledPluginTestApiSync<{
      signalOutbound: ChannelOutboundAdapter;
    }>("signal"));
  }
  return signalOutboundCache;
}

function getSlackOutbound(): ChannelOutboundAdapter {
  if (!slackOutboundCache) {
    ({ slackOutbound: slackOutboundCache } = loadBundledPluginTestApiSync<{
      slackOutbound: ChannelOutboundAdapter;
    }>("slack"));
  }
  return slackOutboundCache;
}

function getTelegramOutbound(): ChannelOutboundAdapter {
  if (!telegramOutboundCache) {
    ({ telegramOutbound: telegramOutboundCache } = loadBundledPluginPublicSurfaceSync<{
      telegramOutbound: ChannelOutboundAdapter;
    }>({
      pluginId: "telegram",
      artifactBasename: "src/outbound-adapter.js",
    }));
  }
  return telegramOutboundCache;
}

function getWhatsAppOutbound(): ChannelOutboundAdapter {
  if (!whatsappOutboundCache) {
    ({ whatsappOutbound: whatsappOutboundCache } = loadBundledPluginTestApiSync<{
      whatsappOutbound: ChannelOutboundAdapter;
    }>("whatsapp"));
  }
  return whatsappOutboundCache;
}

const CASES: ChannelCase[] = [
  {
    name: "Slack",
    channel: "slack",
    to: "channel:C12345",
    sendKey: "sendMessageSlack",
    expectedTo: "channel:C12345",
  },
  {
    name: "Discord",
    channel: "discord",
    to: "channel:789",
    sendKey: "sendMessageDiscord",
    expectedTo: "channel:789",
  },
  {
    name: "WhatsApp",
    channel: "whatsapp",
    to: "+15551234567",
    sendKey: "sendMessageWhatsApp",
    expectedTo: "+15551234567",
  },
  {
    name: "iMessage",
    channel: "imessage",
    to: "friend@example.com",
    sendKey: "sendMessageIMessage",
    expectedTo: "friend@example.com",
  },
];

async function runExplicitAnnounceTurn(params: {
  home: string;
  storePath: string;
  deps: CliDeps;
  channel: ChannelCase["channel"];
  to: string;
}) {
  return await runCronIsolatedAgentTurn({
    cfg: makeCfg(params.home, params.storePath),
    deps: params.deps,
    job: {
      ...makeJob({ kind: "agentTurn", message: "do it" }),
      delivery: {
        mode: "announce",
        channel: params.channel,
        to: params.to,
      },
    },
    message: "do it",
    sessionKey: "cron:job-1",
    lane: "cron",
  });
}

describe("runCronIsolatedAgentTurn core-channel direct delivery", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: createOutboundTestPlugin({ id: "telegram", outbound: getTelegramOutbound() }),
          source: "test",
        },
        {
          pluginId: "signal",
          plugin: createOutboundTestPlugin({ id: "signal", outbound: getSignalOutbound() }),
          source: "test",
        },
        {
          pluginId: "slack",
          plugin: createOutboundTestPlugin({ id: "slack", outbound: getSlackOutbound() }),
          source: "test",
        },
        {
          pluginId: "discord",
          plugin: createOutboundTestPlugin({ id: "discord", outbound: getDiscordOutbound() }),
          source: "test",
        },
        {
          pluginId: "whatsapp",
          plugin: createOutboundTestPlugin({ id: "whatsapp", outbound: getWhatsAppOutbound() }),
          source: "test",
        },
        {
          pluginId: "imessage",
          plugin: createOutboundTestPlugin({ id: "imessage", outbound: getIMessageOutbound() }),
          source: "test",
        },
      ]),
    );
  });

  for (const testCase of CASES) {
    it(`routes ${testCase.name} text-only announce delivery through the outbound adapter`, async () => {
      await withTempCronHome(async (home) => {
        const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
        const deps = createCliDeps();
        mockAgentPayloads([{ text: "hello from cron" }]);

        const res = await runExplicitAnnounceTurn({
          home,
          storePath,
          deps,
          channel: testCase.channel,
          to: testCase.to,
        });

        expect(res.status).toBe("ok");
        expect(res.delivered).toBe(true);
        expect(res.deliveryAttempted).toBe(true);
        expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();

        const sendFn = deps[testCase.sendKey];
        expect(sendFn).toHaveBeenCalledTimes(1);
        expect(sendFn).toHaveBeenCalledWith(
          testCase.expectedTo,
          "hello from cron",
          expect.any(Object),
        );
      });
    });
  }
});
