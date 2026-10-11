import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HOST_BUILDERS = [
  ["extensions/buzz/src/inbound.ts", "params.buildContext ?? buildChannelInboundEventContext"],
  [
    "extensions/clickclack/src/inbound.ts",
    "params.buildContext ?? buildChannelInboundEventContext",
  ],
  [
    "extensions/discord/src/monitor/message-handler.context.ts",
    "ctx.buildContext ?? buildChannelInboundEventContext",
  ],
  ["extensions/feishu/src/bot.ts", "core.channel.inbound.buildContext"],
  ["extensions/feishu/src/comment-handler.ts", "core.channel.inbound.buildContext"],
  ["extensions/googlechat/src/monitor.ts", "core.channel.inbound.buildContext"],
  [
    "extensions/imessage/src/monitor/inbound-processing.ts",
    "params.buildContext ?? buildChannelInboundEventContext",
  ],
  ["extensions/irc/src/inbound.ts", "core.channel.inbound.buildContext"],
  [
    "extensions/line/src/bot-message-context.ts",
    "params.buildContext ?? buildChannelInboundEventContext",
  ],
  ["extensions/matrix/src/matrix/monitor/handler-context.ts", "core.channel.inbound.buildContext"],
  [
    "extensions/msteams/src/monitor-handler/inbound-dispatch.ts",
    "core.channel.inbound.buildContext",
  ],
  ["extensions/nextcloud-talk/src/inbound.ts", "core.channel.inbound.buildContext"],
  [
    "extensions/qa-channel/src/inbound.ts",
    "params.buildContext ?? buildChannelInboundEventContext",
  ],
  ["extensions/raft/src/inbound.ts", "channelRuntime.inbound.buildContext"],
  ["extensions/signal/src/monitor/event-handler.ts", "deps.channelRuntime?.inbound.buildContext"],
  [
    "extensions/slack/src/monitor/message-handler/prepare.ts",
    "ctx.buildContext ?? buildChannelInboundEventContext",
  ],
  ["extensions/sms/src/inbound.ts", "params.channelRuntime.inbound.buildContext"],
  ["extensions/synology-chat/src/inbound-event.ts", "rt.channel.inbound.buildContext"],
  [
    "extensions/telegram/src/bot-message-context.session.ts",
    "sessionRuntime.buildChannelInboundEventContext",
  ],
  ["extensions/tlon/src/monitor/index.ts", "core.channel.inbound.buildContext"],
  ["extensions/twitch/src/monitor.ts", "channelRuntime.inbound.buildContext"],
  [
    "extensions/whatsapp/src/auto-reply/monitor/inbound-dispatch.ts",
    "params.buildContext ?? buildChannelInboundEventContext",
  ],
  ["extensions/zalo/src/monitor.ts", "core.channel.inbound.buildContext"],
  ["extensions/zalouser/src/monitor.ts", "core.channel.inbound.buildContext"],
  [
    "src/channels/direct-dm.ts",
    "const injectedBuilder = params.channelRuntime?.inbound?.buildContext",
  ],
  ["src/channels/feedback-reflection.ts", "buildHostChannelInboundEventContext"],
] as const;

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("channel context builder caller inventory", () => {
  it("routes every production sink through its selected context builder", () => {
    for (const [relativePath, marker] of HOST_BUILDERS) {
      expect(source(relativePath), relativePath).toContain(marker);
    }
    expect(source("extensions/signal/src/monitor.ts")).toContain(
      "channelRuntime: opts.channelRuntime",
    );
  });
});
