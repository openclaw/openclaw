import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";
import {
  configureEventState,
  openEventToolHost,
  runEventFixture,
} from "./session-event.test-support.js";

// mock-isolation: Only model inference is synthetic; admission, tool policy and exec stay real.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);

// #177510: a background exec completion continues its requester's own work. The requester is
// allowed only through toolsBySender (never a command owner) and the wildcard strips exec.
const OWNER = "100001";
const GUEST = "100002";
const ACCOUNT = "owner-account";
const GUILD = "200001";
const CHANNEL = "300001";

// The real channel plugins own the conversation policy: a Telegram DM's entry under
// channels.telegram.direct[chat] (its chat id is the sender id) and a Discord guild channel's
// entry under channels.discord.guilds[guild], which Discord selects by guild id and channel name.
const facade = <T extends object>(pluginId: string) =>
  loadBundledPluginFacade<T>({ pluginId, artifactBasename: "channel-plugin-api.ts" });
const { telegramPlugin } = await facade<{ telegramPlugin: ChannelPlugin }>("telegram");
const { discordPlugin } = await facade<{ discordPlugin: ChannelPlugin }>("discord");
const conversations = {
  dm: {
    sessionKey: "agent:main:completion-reauthorize",
    chatType: "direct",
    route: { channel: "telegram", to: `telegram:${OWNER}`, accountId: ACCOUNT },
    origin: { conversationId: OWNER },
  },
  guild: {
    sessionKey: `agent:main:discord:channel:${CHANNEL}`,
    chatType: "channel",
    route: { channel: "discord", to: `channel:${CHANNEL}`, accountId: ACCOUNT },
    origin: { conversationId: CHANNEL, groupId: CHANNEL, groupSpace: GUILD, groupChannel: "ops" },
  },
} as const;
const denyExec = { deny: ["exec"] };
const direct = (entry: object) => ({ telegram: { direct: { [OWNER]: entry } } });
const channelRevocations = {
  DM: direct({ tools: denyExec }),
  // Keys on the requester's mutable username and display name, not on their id.
  "DM username": direct({ toolsBySender: { "username:alice": denyExec } }),
  "DM name": direct({ toolsBySender: { "name:Alice": denyExec } }),
  guild: { discord: { guilds: { [GUILD]: { tools: denyExec } } } },
  "guild channel": { discord: { guilds: { [GUILD]: { channels: { ops: { tools: denyExec } } } } } },
};
type Revocation = "sender" | keyof typeof channelRevocations;

function policy(revoke?: Revocation, commandOwner?: true): Partial<OpenClawConfig> {
  return {
    ...(commandOwner ? { commands: { ownerAllowFrom: [OWNER] } } : {}),
    channels: revoke && revoke !== "sender" ? channelRevocations[revoke] : {},
    tools: {
      profile: "coding",
      codeMode: false,
      toolSearch: false,
      exec: { host: "gateway", mode: "full" },
      toolsBySender: {
        [`id:${OWNER}`]: revoke === "sender" ? { deny: ["exec"] } : {},
        "*": { deny: ["exec", "process", "nodes", "gateway"] },
      },
    },
  };
}

const retired = "agent harness host capability is no longer active";
const rows: Array<{
  label: string;
  requester: string;
  on?: "guild";
  revoke?: Revocation;
  after?: true;
  to?: string;
  commandOwner?: true;
  outcome: string;
}> = [
  { label: "owner", requester: OWNER, outcome: "ran" },
  { label: "guest", requester: GUEST, outcome: "absent" },
  {
    label: "sender revoked before admission",
    requester: OWNER,
    revoke: "sender",
    outcome: "absent",
  },
  { label: "DM revoked before admission", requester: OWNER, revoke: "DM", outcome: "absent" },
  { label: "DM username entry", requester: OWNER, revoke: "DM username", outcome: "absent" },
  { label: "DM name entry", requester: OWNER, revoke: "DM name", outcome: "absent" },
  {
    label: "command owner, DM revoked before admission",
    requester: OWNER,
    revoke: "DM",
    commandOwner: true,
    outcome: "absent",
  },
  // A turn routed to another chat is not a direct turn, so it cannot carry the DM's requester.
  {
    label: "DM revoked, completion routed to another chat",
    requester: OWNER,
    revoke: "DM",
    to: "telegram:-100200",
    outcome: "absent",
  },
  { label: "Discord guild channel", requester: OWNER, on: "guild", outcome: "ran" },
  { label: "guild revoked", requester: OWNER, on: "guild", revoke: "guild", outcome: "absent" },
  {
    label: "guild channel revoked",
    requester: OWNER,
    on: "guild",
    revoke: "guild channel",
    outcome: "absent",
  },
  // Revoking publishes config, which retires the admitted turn's tool host before the call.
  {
    label: "sender revoked after admission",
    requester: OWNER,
    revoke: "sender",
    after: true,
    outcome: retired,
  },
  {
    label: "DM revoked after admission",
    requester: OWNER,
    revoke: "DM",
    after: true,
    outcome: retired,
  },
];

it.for(rows)(
  "runs completion-side exec only under the requester's current sender and conversation policy: $label",
  async (row, { signal, onTestFinished }) => {
    const { sessionKey, chatType, route, origin } = conversations[row.on ?? "dm"];
    const scope = { agentId: "main", sessionKey };
    await runEventFixture("session-event-completion-reauthorize", onTestFinished, async (state) => {
      const registry = captureActivePluginRegistrySnapshot();
      onTestFinished(() => restoreActivePluginRegistrySnapshot(registry));
      setActivePluginRegistry(
        createTestRegistry([
          { pluginId: "telegram", source: "test", plugin: telegramPlugin },
          { pluginId: "discord", source: "test", plugin: discordPlugin },
        ]),
      );
      const config = await configureEventState(state, policy(undefined, row.commandOwner));
      await replaceSessionEntry(scope, {
        sessionId: "completion-reauthorize",
        permissionMode: "full",
        updatedAt: Date.now(),
        chatType,
        delivery: {
          kind: "external",
          route: { channel: route.channel, accountId: ACCOUNT, target: { to: route.to } },
          context: route,
          origin: { provider: route.channel, chatType, accountId: ACCOUNT },
        },
      });
      // The host-owned exec caller supplies the requester and conversation it spoke in.
      const target = await withGatewayToolCallerIdentity(
        {
          ...scope,
          requesterOrigin: {
            ...scope,
            ...origin,
            messageProvider: route.channel,
            accountId: ACCOUNT,
            chatType,
            senderId: row.requester,
            senderUsername: "alice",
            senderName: "Alice",
          },
        },
        () =>
          captureSessionEventTargetForHost(scope.agentId, scope.sessionKey, {
            retainRequesterOwner: true,
          }),
      );
      const revoke = () =>
        setRuntimeConfigSnapshot({ ...config, ...policy(row.revoke, row.commandOwner) });
      if (row.revoke && !row.after) {
        revoke();
      }
      const marker = path.join(state.workspaceDir, "completion-exec.txt");
      const seen: { offered?: boolean; outcome?: string; senderIsOwner?: boolean } = {};
      runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
        const { tools, close } = await openEventToolHost(params, "completion admission", {
          includeShellTools: true,
        });
        const exec = tools.find((tool) => tool.name === "exec");
        seen.offered = Boolean(exec);
        seen.senderIsOwner = params.senderIsOwner;
        if (row.after) {
          revoke();
        }
        seen.outcome = await (
          exec
            ? exec.execute("completion-exec", { command: `printf ran > '${marker}'` }).then(
                () => "ran",
                (error: unknown) => (error instanceof Error ? error.message : String(error)),
              )
            : Promise.resolve("absent")
        ).finally(close);
        return { payloads: [{ text: "Completion observed" }], meta: { durationMs: 1 } };
      });
      const receipt = enqueueSessionEventForHost("Background command finished.", {
        ...scope,
        source: "exec",
        expectedTarget: target,
        abortSignal: signal,
        deliver: false,
        deliveryContext: { ...route, to: row.to ?? route.to },
      });
      await expect(receipt.settled).resolves.toMatchObject({ status: "completed" });
      const ran = await fs.readFile(marker, "utf8").then(
        (text) => text === "ran",
        () => false,
      );
      // A requester allowed only by toolsBySender is not a command owner and never becomes one.
      expect({ ...seen, ran }).toEqual({
        offered: row.outcome !== "absent",
        outcome: row.outcome,
        senderIsOwner: row.commandOwner === true,
        ran: row.outcome === "ran",
      });
    });
  },
);
