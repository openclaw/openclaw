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
// A Telegram DM's chat id is its sender id.
const OWNER = "100001";
const GUEST = "100002";
const ACCOUNT = "owner-account";
const scope = { agentId: "main", sessionKey: "agent:main:completion-reauthorize" };
const route = { channel: "telegram", to: `telegram:${OWNER}`, accountId: ACCOUNT };

// The real Telegram plugin owns the DM policy: channels.telegram.direct[chat].
const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "channel-plugin-api.ts",
});
const dmRevocations = {
  DM: { tools: { deny: ["exec"] } },
  // Keys on the requester's mutable username and display name, not on their id.
  "DM username": { toolsBySender: { "username:alice": { deny: ["exec"] } } },
  "DM name": { toolsBySender: { "name:Alice": { deny: ["exec"] } } },
};
type Revocation = "sender" | keyof typeof dmRevocations;

function policy(revoke?: Revocation, commandOwner?: true): Partial<OpenClawConfig> {
  return {
    ...(commandOwner ? { commands: { ownerAllowFrom: [OWNER] } } : {}),
    channels: {
      telegram: revoke && revoke !== "sender" ? { direct: { [OWNER]: dmRevocations[revoke] } } : {},
    },
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
  "runs completion-side exec only under the requester's current sender and DM policy: $label",
  async (row, { signal, onTestFinished }) => {
    await runEventFixture("session-event-completion-reauthorize", onTestFinished, async (state) => {
      const registry = captureActivePluginRegistrySnapshot();
      onTestFinished(() => restoreActivePluginRegistrySnapshot(registry));
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
      );
      const config = await configureEventState(state, policy(undefined, row.commandOwner));
      await replaceSessionEntry(scope, {
        sessionId: "completion-reauthorize",
        permissionMode: "full",
        updatedAt: Date.now(),
        chatType: "direct",
        delivery: {
          kind: "external",
          route: { channel: "telegram", accountId: ACCOUNT, target: { to: route.to } },
          context: route,
          origin: { provider: "telegram", chatType: "direct", accountId: ACCOUNT },
        },
      });
      // The host-owned exec caller supplies the requester and conversation it spoke in.
      const target = await withGatewayToolCallerIdentity(
        {
          ...scope,
          requesterOrigin: {
            ...scope,
            messageProvider: "telegram",
            accountId: ACCOUNT,
            chatType: "direct",
            conversationId: OWNER,
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
