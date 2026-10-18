import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const injected = "params.buildContext ?? buildChannelInboundEventContext";
const coreBuilder = "core.channel.inbound.buildContext";
const globalBuilder = "runtime.channel.inbound.buildContext";
// Each sink must carry ingress through its selected builder, never a late global lookup.
const SINKS: ReadonlyArray<readonly [string, string, string, string?]> = [
  ["buzz/src/inbound", "channelIngress: access", injected, globalBuilder],
  ["clickclack/src/inbound", "channelIngress: access.channelIngress", injected, globalBuilder],
  [
    "discord/src/monitor/message-handler.context",
    "channelIngress,",
    "ctx.buildContext ?? buildChannelInboundEventContext",
    "getDiscordRuntime().channel.inbound.buildContext",
  ],
  ["feishu/src/bot", "channelIngress:", coreBuilder],
  ["feishu/src/comment-handler", "channelIngress:", coreBuilder],
  ["googlechat/src/monitor", "channelIngress: access.channelIngress", coreBuilder],
  [
    "imessage/src/monitor/inbound-processing",
    "channelIngress,",
    injected,
    "getIMessageRuntime().channel.inbound.buildContext",
  ],
  ["irc/src/inbound", "channelIngress: access", coreBuilder],
  [
    "line/src/bot-message-context",
    "channelIngress: params.channelIngress",
    injected,
    "getLineRuntime().channel.inbound.buildContext",
  ],
  ["matrix/src/matrix/monitor/handler-context", "channelIngress,", coreBuilder],
  [
    "msteams/src/monitor-handler/message-handler",
    "channelIngress:",
    "dispatchCore.channel.inbound.buildContext",
  ],
  ["nextcloud-talk/src/inbound", "channelIngress: access", coreBuilder],
  ["qa-channel/src/inbound", "channelIngress: access", injected, globalBuilder],
  ["raft/src/inbound", 'channelIngress: "unsupported"', "channelRuntime.inbound.buildContext"],
  [
    "signal/src/monitor/event-handler",
    "channelIngress: entry.channelIngress",
    "deps.channelRuntime?.inbound.buildContext",
  ],
  [
    "slack/src/monitor/message-handler/prepare",
    "channelIngress: messageIngress",
    "ctx.buildContext ?? buildChannelInboundEventContext",
    "getSlackRuntime().channel.inbound.buildContext",
  ],
  ["sms/src/inbound", "channelIngress: auth", "params.channelRuntime.inbound.buildContext"],
  ["synology-chat/src/inbound-event", "channelIngress,", "rt.channel.inbound.buildContext"],
  [
    "telegram/src/bot-message-context.session",
    "channelIngress,",
    "sessionRuntime.buildChannelInboundEventContext",
  ],
  ["tlon/src/monitor/index", "channelIngress,", coreBuilder],
  ["twitch/src/monitor", "channelIngress,", "channelRuntime.inbound.buildContext"],
  [
    "whatsapp/src/auto-reply/monitor/inbound-dispatch",
    "channelIngress,",
    injected,
    "getWhatsAppRuntime().channel.inbound.buildContext",
  ],
  ["zalo/src/monitor", "channelIngress,", coreBuilder],
  ["zalouser/src/monitor", "channelIngress: accessDecision", coreBuilder],
  [
    "src/channels/direct-dm",
    "channelIngress: params.channelIngress",
    "const injectedBuilder = params.channelRuntime?.inbound?.buildContext",
  ],
  [
    "src/channels/feedback-reflection",
    'channelIngress: "unsupported"',
    "buildHostChannelInboundEventContext",
  ],
] as const;

const CONTEXT_BINDING_PRODUCERS = [
  "buzz/src/inbound",
  "clickclack/src/access",
  "discord/src/monitor/message-handler.preflight",
  "feishu/src/policy",
  "googlechat/src/monitor-access",
  "imessage/src/monitor/inbound-processing",
  "irc/src/inbound",
  "line/src/bot-handlers",
  "matrix/src/matrix/monitor/access-state",
  "msteams/src/monitor-handler/access",
  "nextcloud-talk/src/inbound",
  "nostr/src/gateway",
  "qa-channel/src/inbound",
  "signal/src/monitor/access-policy",
  "slack/src/monitor/auth",
  "sms/src/inbound",
  "synology-chat/src/security",
  "telegram/src/bot-handlers.inbound-authorization",
  "tlon/src/monitor/utils",
  "twitch/src/access-control",
  "whatsapp/src/inbound-policy",
  "zalo/src/monitor",
  "zalouser/src/monitor",
] as const;
const SCOPED_BUILDER_HANDOFFS = [
  ["buzz/src/gateway", "const buildContext = channelRuntime?.inbound.buildContext"],
  ["clickclack/src/gateway", "buildContext: params.buildContext"],
  ["discord/src/monitor/provider", "buildContext: pluginChannelRuntime?.inbound.buildContext"],
  [
    "imessage/src/monitor/monitor-provider",
    "buildContext: pluginChannelRuntime?.inbound.buildContext",
  ],
  ["line/src/gateway", 'ctx.channelRuntime as PluginRuntime["channel"] | undefined'],
  ["line/src/bot", "buildContext: opts.buildContext"],
  ["line/src/bot-handlers", "buildContext: context.buildContext"],
  ["nostr/src/gateway", "channelRuntime,"],
  [
    "qa-channel/src/gateway",
    "channelRuntime?.inbound.buildContext ?? buildChannelInboundEventContext",
  ],
  ["slack/src/monitor/context", 'params.channelRuntime as PluginRuntime["channel"] | undefined'],
  ["telegram/src/monitor", "buildContext: pluginChannelRuntime?.inbound.buildContext"],
  ["telegram/src/webhook", "buildContext: opts.buildContext"],
  ["telegram/src/polling-session", "buildContext: this.opts.buildContext"],
  ["telegram/src/bot-core", "buildContext: opts.buildContext"],
  ["telegram/src/bot-message", "buildContext ?? buildChannelInboundEventContext"],
  ["whatsapp/src/auto-reply/monitor", "buildContext: pluginChannelRuntime?.inbound.buildContext"],
  ["whatsapp/src/auto-reply/monitor/on-message", "buildContext: params.buildContext"],
  ["whatsapp/src/auto-reply/monitor/process-message", "buildContext: params.buildContext"],
] as const;

function source(file: string): string {
  return fs.readFileSync(
    path.join(process.cwd(), file.startsWith("src/") ? file + ".ts" : "extensions/" + file + ".ts"),
    "utf8",
  );
}

it("keeps all production sinks wired to exact ingress or named unsupported paths", () => {
  for (const [file, ingress] of SINKS) {
    expect(source(file), file).toContain(ingress);
  }
});
it("binds all supported producers to finalized host context identity", () => {
  for (const file of CONTEXT_BINDING_PRODUCERS) {
    expect(source(file), file).toContain("contextBinding");
  }
});
it("routes every production sink through its selected context builder", () => {
  for (const [file, , builder] of SINKS) {
    expect(source(file), file).toContain(builder);
  }
  expect(source("signal/src/monitor")).toContain("channelRuntime: opts.channelRuntime");
});
it("does not rediscover host context builders through process-global runtime stores", () => {
  for (const sink of SINKS) {
    const [file] = sink;
    const late = sink[3];
    if (late) {
      expect(source(file), file).not.toContain(late);
    }
  }
});
it("hands scoped context builders from each migrated startup path to its sink", () => {
  for (const [file, marker] of SCOPED_BUILDER_HANDOFFS) {
    expect(source(file), file).toContain(marker);
  }
});
it("keeps direct-DM classifications at their authoritative producers", () => {
  expect(source("nostr/src/gateway")).toContain("resolveChannelIngress: async (contextBinding)");
  expect(source("reef/src/channel")).toContain('channelIngress: "unsupported"');
});
