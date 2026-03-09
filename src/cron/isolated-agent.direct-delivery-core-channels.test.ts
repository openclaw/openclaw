import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it } from "vitest";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import { discordOutbound } from "../channels/plugins/outbound/discord.js";
import { imessageOutbound } from "../channels/plugins/outbound/imessage.js";
import { signalOutbound } from "../channels/plugins/outbound/signal.js";
import { slackOutbound } from "../channels/plugins/outbound/slack.js";
import { telegramOutbound } from "../channels/plugins/outbound/telegram.js";
import { whatsappOutbound } from "../channels/plugins/outbound/whatsapp.js";
import type { CliDeps } from "../cli/deps.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
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
          plugin: createOutboundTestPlugin({ id: "telegram", outbound: telegramOutbound }),
          source: "test",
        },
        {
          pluginId: "signal",
          plugin: createOutboundTestPlugin({ id: "signal", outbound: signalOutbound }),
          source: "test",
        },
        {
          pluginId: "slack",
          plugin: createOutboundTestPlugin({ id: "slack", outbound: slackOutbound }),
          source: "test",
        },
        {
          pluginId: "discord",
          plugin: createOutboundTestPlugin({ id: "discord", outbound: discordOutbound }),
          source: "test",
        },
        {
          pluginId: "whatsapp",
          plugin: createOutboundTestPlugin({ id: "whatsapp", outbound: whatsappOutbound }),
          source: "test",
        },
        {
          pluginId: "imessage",
          plugin: createOutboundTestPlugin({ id: "imessage", outbound: imessageOutbound }),
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
